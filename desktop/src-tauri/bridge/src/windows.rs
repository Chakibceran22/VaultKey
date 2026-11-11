//! Windows: who may open VaultKey's pipe, and who is behind it (`plans/06-desktop.md` §1).
//!
//! - The app creates the pipe with an explicit, protected DACL that grants the current
//!   user, and no one else, access ([`UserOnly`]). The default pipe security would let
//!   other local users open it read-only.
//! - The bridge, before relaying anything, checks that the process serving the pipe runs
//!   as the same user ([`server_is_current_user`]): another user who created the name
//!   first gets nothing.
//! - The name carries the user's SID ([`current_user_sid_string`]), unique per account.

use std::{ffi::c_void, io, mem, ptr};

use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        },
        GetLengthSid, GetTokenInformation, IsValidSid, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

/// Closes a handle when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: a handle this module opened and nothing else closes.
        unsafe { CloseHandle(self.0) };
    }
}

fn check(succeeded: i32) -> io::Result<()> {
    if succeeded == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// The SID of the user a process runs as, as bytes.
fn process_user_sid(process: HANDLE) -> io::Result<Vec<u8>> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `token` receives a handle that `Owned` closes.
    check(unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) })?;
    let token = Owned(token);
    let mut size = 0u32;
    // SAFETY: a size query (null buffer); it fails with ERROR_INSUFFICIENT_BUFFER and sets `size`.
    unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size) };
    if size as usize <= mem::size_of::<TOKEN_USER>() {
        return Err(io::Error::last_os_error());
    }
    // u64s: TOKEN_USER holds pointers, so the buffer must be pointer-aligned.
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    // SAFETY: `buffer` holds at least `size` bytes.
    check(unsafe { GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr().cast(), size, &mut size) })?;
    // SAFETY: GetTokenInformation(TokenUser) wrote a TOKEN_USER at the start of `buffer`,
    // whose SID points into the same buffer, which outlives these reads.
    unsafe {
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let sid = user.User.Sid;
        if IsValidSid(sid) == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "the token's SID is invalid"));
        }
        let length = GetLengthSid(sid) as usize;
        Ok(std::slice::from_raw_parts(sid.cast::<u8>(), length).to_vec())
    }
}

fn current_user_sid() -> io::Result<Vec<u8>> {
    // SAFETY: the pseudo-handle of this process; it needs no closing.
    process_user_sid(unsafe { GetCurrentProcess() })
}

/// The current user's SID as text: `S-1-5-21-…`.
pub fn current_user_sid_string() -> io::Result<String> {
    let mut sid = current_user_sid()?;
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: `sid` is a valid SID (from the token); `text` is freed with LocalFree below.
    check(unsafe { ConvertSidToStringSidW(sid.as_mut_ptr().cast(), &mut text) })?;
    // SAFETY: a NUL-terminated wide string from ConvertSidToStringSidW.
    let string = unsafe {
        let length = (0..).take_while(|&i| *text.add(i) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(text, length))
    };
    // SAFETY: allocated by ConvertSidToStringSidW with LocalAlloc.
    unsafe { LocalFree(text.cast()) };
    Ok(string)
}

/// Security attributes that let only the current user open the pipe. Keep it alive
/// while creating pipe instances with it.
pub struct UserOnly {
    descriptor: *mut c_void,
    attributes: SECURITY_ATTRIBUTES,
}

// The descriptor is owned memory, only read by the pipe-creating calls.
unsafe impl Send for UserOnly {}
unsafe impl Sync for UserOnly {}

impl UserOnly {
    pub fn new() -> io::Result<Self> {
        // D:P: a protected DACL (nothing inherited); one entry: GENERIC_ALL for the user.
        let sddl = format!("D:P(A;;GA;;;{})", current_user_sid_string()?);
        let wide: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
        let mut descriptor: *mut c_void = ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; the descriptor is freed in Drop.
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(wide.as_ptr(), SDDL_REVISION_1, &mut descriptor, ptr::null_mut())
        })?;
        Ok(Self {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            },
        })
    }

    /// For `ServerOptions::create_with_security_attributes_raw`.
    pub fn as_raw(&mut self) -> *mut c_void {
        ptr::from_mut(&mut self.attributes).cast()
    }
}

impl Drop for UserOnly {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.descriptor) };
    }
}

/// Whether the process serving `pipe` (a connected client end) runs as the current user.
/// Borrowing the pipe keeps its handle open for the whole check.
pub fn server_is_current_user(pipe: &impl std::os::windows::io::AsRawHandle) -> io::Result<bool> {
    let mut process_id = 0u32;
    // SAFETY: the handle belongs to `pipe`, which is borrowed, so it stays open.
    check(unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut process_id) })?;
    // SAFETY: a query-only handle, closed by `Owned`.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = Owned(process);
    Ok(process_user_sid(process.0)? == current_user_sid()?)
}
