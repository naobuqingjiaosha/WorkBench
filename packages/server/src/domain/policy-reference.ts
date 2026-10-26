/** 只认当前用户消息中的直接请求，不从历史、模板设置或模型参数继承。 */
export function requestsPolicyReference(message?: string): boolean {
  const direct = (message ?? '').replace(/["'“”「」『』][^"'“”「」『』]*["'“”「」『』]/g, '');
  return direct.split(/[，,。；;！!？?\n]/).some(part => /^\s*(?:请\s*)?帮我参考制度(?:\s|$|[：:，,。；;]|并|来|后|生成|写|修改)/.test(part));
}
