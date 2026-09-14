import { buildSimulatedSendScript } from './sendSimulator'

const INPUT_SELECTORS = [
  '.pub-send-txt',
  '[class*="send"] textarea',
  '[class*="chat"] textarea',
  'div[contenteditable="true"]',
  'textarea[class*="input"]'
]

const BUTTON_SELECTORS = [
  '[class*="send-btn"]',
  '[class*="send"] button',
  'button[class*="send"]'
]

/** 虎牙直播间发送弹幕（选择器待真实环境确认，见项目记忆「待联调项」） */
export function buildHuyaSendScript(text: string): string {
  return buildSimulatedSendScript(text, INPUT_SELECTORS, BUTTON_SELECTORS)
}
