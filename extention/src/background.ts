import { MessageType } from "./types/MessageTypes"

chrome.runtime.onInstalled.addListener(() => {
  console.log('[VaultKey] Extension installed!')
  chrome.storage.local.set({ backendUrl: 'http://localhost:3000' })
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === MessageType.OPEN_SIDEPANEL) {
    chrome.sidePanel.open({ tabId: sender.tab!.id! })
    sendResponse({ success: true })
  }

  if (msg.type === MessageType.FILL_FIELDS) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      chrome.tabs.sendMessage(tab.id!, {
        type: MessageType.FILL_FIELDS,
        payload: msg.payload
      })
      sendResponse({ success: true }) // ← inside the callback
    })
  }

  return true
})