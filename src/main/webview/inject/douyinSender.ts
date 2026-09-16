import { buildSimulatedSendScript } from './sendSimulator'

const INPUT_SELECTORS = [
  // 抖音前端带 data-e2e 埋点属性，比哈希类名稳定，优先用
  '[data-e2e="chat-input"]',
  '.webcast-chatroom___input',
  '[class*="chatroom"] [contenteditable="true"]',
  '[class*="chatroom"] textarea',
  '[class*="chat-input"]',
  'div[contenteditable="true"]',
  'textarea'
]

const BUTTON_SELECTORS = [
  '[data-e2e="chat-send"]',
  '[class*="chatroom"] button[class*="send"]',
  '[class*="send"] button',
  'button[class*="send"]'
]

/**
 * 抖音直播间发送弹幕。
 *
 * 抖音输入框是 `contenteditable` 富文本（编辑器会吃掉直接赋值），
 * 因此必须走 `execCommand('insertText')` 并回读校验 —— 见 sendSimulator 顶部说明。
 * ⚠️ 选择器仍需真实直播间联调确认；未命中会如实返回失败码，而不是假装发送成功。
 */
export function buildDouyinSendScript(text: string): string {
  return buildSimulatedSendScript(text, INPUT_SELECTORS, BUTTON_SELECTORS)
}
