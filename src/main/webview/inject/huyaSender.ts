import { buildSimulatedSendScript } from './sendSimulator'

/**
 * 输入框候选（按优先级）。
 *
 * 依据 2026-09-17 在 live.huya.com 实页 DOM 侦察的结果：
 * 页面上存在的输入框是 `input.player-full-input-txt`（全屏播放器里的弹幕输入，
 * placeholder「按回车键可以快速发弹幕」，默认隐藏）与站内搜索框；
 * 主聊天输入框只在登录后渲染，故把虎牙常见类名一并列出并保留通用兜底。
 */
const INPUT_SELECTORS = [
  '#pub_msg_input',
  'input.pub_msg_input',
  '.pub-send-txt',
  'input.player-full-input-txt',
  '[class*="chat-room"] textarea',
  '[class*="chat"] textarea',
  'div[contenteditable="true"]',
  'textarea'
]

/**
 * 发送按钮候选。
 * `span.btn-sendMsg` 是本轮在实页 DOM 里**直接看到的**「发送」按钮（文本恰为「发送」）。
 */
const BUTTON_SELECTORS = [
  '.btn-sendMsg',
  'span.btn-sendMsg',
  '[class*="btn-send"]',
  '[class*="send"] button',
  'button[class*="send"]'
]

/**
 * 虎牙直播间发送弹幕。
 * ⚠️ 主聊天输入框的选择器仍需在**登录态**实页确认（本轮为游客态，只见全屏输入框）；
 * 未命中会如实返回失败码，不会假装发送成功。
 */
export function buildHuyaSendScript(text: string): string {
  return buildSimulatedSendScript(text, INPUT_SELECTORS, BUTTON_SELECTORS)
}
