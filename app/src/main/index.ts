import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import axios from 'axios'

const API_URL = __API_URL__
console.log(API_URL)
function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    show: false,
    title: "ValultKey",
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })


  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
ipcMain.handle('auth-status', async () => {
  try {
    console.log("Checking authentication status...")
    const response = await axios.get(`${API_URL}/auth/status`)
    console.log("Auth status response:", response.data)
    return response.data
  } catch (err) {
    console.log("im in erer ", err)
    return { error: true }
  }
})

ipcMain.handle('register-auth-key', async (_, authKey: string) => {
  try {
    const response = await axios.post(`${API_URL}/auth/register`, { authKey })
    return response.data
  } catch (error) {
    console.log("Error registering auth key:", error)
    throw error
  }
})
ipcMain.handle('verify-master', async (_, password: string) => {
  try {
    const response = await axios.post(`${API_URL}/auth/verify`, { authKey: password })
    const result = await response.data
    return result
  } catch (error) {
    console.log("Error verifying master password:", error)
  }
  console.log(password)
})

ipcMain.handle('fetch-domains', async (_, token: string) => {
  try {
    const response = await axios.get(`${API_URL}/domain/fetch`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    return response.data
  } catch (error) {
    console.log("Error fetching domains:", error)
    throw new Error('Failed to fetch domains')
  }
})

ipcMain.handle('register-domain', async (_, token: string, domainName: string) => {
  try {
    const response = await axios.post(`${API_URL}/domain/register`, { name: domainName }, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    return response.data
  } catch (error: any) {
    console.log("message:", error.response?.data?.message) // check this
    throw new Error(error.response?.data?.message || 'Failed to register domain')
  }
})
ipcMain.handle('delete-domain', async (_, token: string, domainId: number) => {
  try {
    console.log("Deleting domain with ID:", domainId)
    const response  = await axios.delete(`${API_URL}/domain/delete/${domainId}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    return response.data
  } catch (error) {
    console.log("Error deleting domain:", error)
    throw new Error('Failed to delete domain')
  }
})

ipcMain.handle('fetch-credentials', async (_, token: string, domainId: number) => {
  try {
    const credentials = await axios.get(`${API_URL}/credential/${domainId}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    
    return credentials.data

  } catch (error) {
    console.log("Error fetching credentials:", error)
    throw new Error('Failed to fetch credentials')
  }
})

ipcMain.handle('create-credential', async (_, token: string, credentialDTO: any) => {
  try {
    const response = await axios.post(`${API_URL}/credential/create`, credentialDTO, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    return response.data
  } catch (error: any) {
    throw new Error(error.response?.data?.message || 'Failed to create credential')
  }
})

ipcMain.handle('delete-credential', async (_, token: string, credentialId: number) => {
  try {
    const reponse = await axios.delete(`${API_URL}/credential/delete/${credentialId}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    return reponse.data
  } catch (error) {
    console.log("Error deleting credential:", error)
    throw new Error('Failed to delete credential')
  }
})

ipcMain.handle('update-credential', async (_, token: string, credentialId: number, updatedFields: any) => {
  try {
    const response = await axios.put(`${API_URL}/credential/update/${credentialId}`, { ...updatedFields }, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
    return response.data
  } catch (error: any ) {
    console.log("Error updating credential:", error.response?.data || error.message)
    throw new Error('Failed to update credential')
  }
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
