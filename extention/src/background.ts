import { MessageType } from "./types/MessageTypes"

chrome.runtime.onInstalled.addListener(() => {
  console.log('[VaultKey] Extension installed!')
    chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });

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


chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
});

// Listen for the alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // just wakes the worker — no-op is fine
  }
});