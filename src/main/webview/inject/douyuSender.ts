import { buildSimulatedSendScript } from './sendSimulator'

const INPUT_SELECTORS = [
  '.ChatSend-txt',
  '[class*="ChatSend"] textarea',
  '[class*="chat"] textarea',
  'div[contenteditable="true"]',
  'textarea[class*="input"]'
]

const BUTTON_SELECTORS = [
  '[class*="ChatSend"] button',
  '[class*="send"] button',
  'button[class*="send"]'
]

/** 斗鱼直播间发送弹幕（选择器待真实环境确认，见项目记忆「待联调项」） */
export function buildDouyuSendScript(text: string): string {
  return buildSimulatedSendScript(text, INPUT_SELECTORS, BUTTON_SELECTORS)
}
