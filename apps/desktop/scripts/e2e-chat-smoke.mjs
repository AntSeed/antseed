import { _electron as electron } from 'playwright';
import electronBinary from 'electron';

const APP_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 120_000;

let electronApp;
const consoleErrors = [];

try {
  electronApp = await electron.launch({
    executablePath: electronBinary,
    args: ['.'],
    cwd: process.cwd(),
    timeout: APP_TIMEOUT_MS,
  });

  const page = await electronApp.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.waitForSelector('#chatNewBtn', { timeout: UI_TIMEOUT_MS });
  await page.click('#chatNewBtn');

  await page.waitForFunction(() => {
    const input = document.getElementById('chatInput');
    const send = document.getElementById('chatSendBtn');
    const legacyReady = Boolean(input && send && !input.disabled && !send.disabled);
    const litTextarea = document.querySelector('#chatAgentHost message-editor textarea');
    return legacyReady || Boolean(litTextarea);
  }, { timeout: ACTION_TIMEOUT_MS });

  const messageText = `e2e smoke ${Date.now()}`;
  const usingLegacyComposer = await page.evaluate(() => {
    const input = document.getElementById('chatInput');
    const send = document.getElementById('chatSendBtn');
    return Boolean(input && send);
  });

  if (usingLegacyComposer) {
    await page.fill('#chatInput', messageText);
    await page.click('#chatSendBtn');
  } else {
    await page.evaluate((text) => {
      const editor = document.querySelector('#chatAgentHost message-editor');
      if (editor && typeof editor.onSend === 'function') {
        editor.onSend(text, []);
        return;
      }
      const textarea = document.querySelector('#chatAgentHost message-editor textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error('Lit composer textarea not found');
      }
      textarea.focus();
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const sendIcon = document.querySelector('#chatAgentHost message-editor [data-lucide="send"]');
      const sendButton = sendIcon?.closest('button');
      if (sendButton instanceof HTMLButtonElement) {
        sendButton.click();
        return;
      }
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, messageText);
  }

  await page.waitForFunction((needle) => {
    const legacyNodes = Array.from(document.querySelectorAll('#chatMessages .chat-bubble.own .chat-bubble-content'));
    const litNodes = Array.from(document.querySelectorAll('#chatAgentHost user-message'));
    const legacyHasNeedle = legacyNodes.some((node) => (node.textContent || '').includes(needle));
    const litStreaming = Boolean(document.querySelector('#chatAgentHost message-editor [data-lucide="square"]'));
    const litTextarea = document.querySelector('#chatAgentHost message-editor textarea');
    const litComposerCleared = litTextarea instanceof HTMLTextAreaElement && litTextarea.value.trim().length === 0;
    const errorText = (document.getElementById('chatError')?.textContent || '').trim();
    return legacyHasNeedle || litNodes.length > 0 || litStreaming || litComposerCleared || errorText.length > 0;
  }, messageText, { timeout: ACTION_TIMEOUT_MS });

  const baselineAssistantCount = await page.evaluate(() => {
    return document.querySelectorAll('#chatMessages .chat-bubble.other, #chatAgentHost assistant-message').length;
  });

  await page.waitForFunction((initialAssistantCount) => {
    const assistantCount = document.querySelectorAll('#chatMessages .chat-bubble.other, #chatAgentHost assistant-message').length;
    const errorText = (document.getElementById('chatError')?.textContent || '').trim();
    return assistantCount > initialAssistantCount || errorText.length > 0;
  }, baselineAssistantCount, { timeout: RESPONSE_TIMEOUT_MS });

  await page.waitForFunction(() => {
    const input = document.getElementById('chatInput');
    const send = document.getElementById('chatSendBtn');
    const abort = document.getElementById('chatAbortBtn');
    const abortVisible = abort ? !String(abort.getAttribute('style') || '').includes('none') : false;
    const legacyReady = Boolean(input && send && !input.disabled && !send.disabled && !abortVisible);
    const litTextarea = document.querySelector('#chatAgentHost message-editor textarea');
    const litAbortVisible = Boolean(document.querySelector('#chatAgentHost message-editor [data-lucide="square"]'));
    const litReady = Boolean(litTextarea && !litAbortVisible);
    return legacyReady || litReady;
  }, undefined, { timeout: RESPONSE_TIMEOUT_MS });

  const summary = await page.evaluate(() => {
    const errorText = (document.getElementById('chatError')?.textContent || '').trim();
    return {
      conversations: document.querySelectorAll('#chatConversations .chat-conv-item').length,
      ownMessages: document.querySelectorAll('#chatMessages .chat-bubble.own, #chatAgentHost user-message').length,
      assistantMessages: document.querySelectorAll('#chatMessages .chat-bubble.other, #chatAgentHost assistant-message').length,
      usingLegacyComposer: Boolean(document.getElementById('chatInput') && document.getElementById('chatSendBtn')),
      inputDisabled: Boolean(document.getElementById('chatInput')?.disabled),
      sendDisabled: Boolean(document.getElementById('chatSendBtn')?.disabled),
      litInputMissing: !document.querySelector('#chatAgentHost message-editor textarea'),
      litAbortVisible: Boolean(document.querySelector('#chatAgentHost message-editor [data-lucide="square"]')),
      errorText,
    };
  });

  const assistantIncreased = summary.assistantMessages > baselineAssistantCount;
  const hasChatError = summary.errorText.length > 0;
  if (!assistantIncreased && !hasChatError) {
    throw new Error('Chat send neither produced an assistant message nor surfaced an error');
  }
  if (summary.usingLegacyComposer && (summary.inputDisabled || summary.sendDisabled)) {
    throw new Error('Chat composer remained disabled after response completed');
  }
  if (!summary.usingLegacyComposer && summary.litInputMissing) {
    throw new Error('Lit composer textarea was not found');
  }
  if (!summary.usingLegacyComposer && summary.litAbortVisible) {
    throw new Error('Lit composer remained in streaming state after response completed');
  }

  console.log('E2E_CHAT_SMOKE_PASS', JSON.stringify(summary));
  if (consoleErrors.length > 0) {
    console.log('E2E_CHAT_SMOKE_CONSOLE_ERRORS', JSON.stringify(consoleErrors));
  }
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error('E2E_CHAT_SMOKE_FAIL', message);
  if (consoleErrors.length > 0) {
    console.error('E2E_CHAT_SMOKE_CONSOLE_ERRORS', JSON.stringify(consoleErrors));
  }
  process.exitCode = 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
}
