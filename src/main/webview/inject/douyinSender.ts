import { buildSimulatedSendScript } from './sendSimulator'

const INPUT_SELECTORS = [
  '.webcast-chatroom___input',
  '[class*="chatroom"][class*="input"]',
  'div[contenteditable="true"]',
  'textarea[class*="input"]',
  '.semi-input',
  'input[class*="input"]'
]

const BUTTON_SELECTORS = ['[class*="send"] button', 'button[class*="send"]']

/** 抖音直播间发送弹幕（选择器待真实环境确认，见项目记忆「待联调项」） */
export function buildDouyinSendScript(text: string): string {
  return buildSimulatedSendScript(text, INPUT_SELECTORS, BUTTON_SELECTORS)
}
