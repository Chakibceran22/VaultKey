chrome.runtime.onInstalled.addListener(() => {
  console.log('[VaultKey] Extension installed!')
  
  // set default backend URL
  chrome.storage.local.set({ backendUrl: 'http://localhost:3000' })
  console.log('[VaultKey] Default backend URL set')
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[VaultKey] Message received:', msg)
  sendResponse({ success: true })
  return true
})