declare const __WEBUI_BUILD_INFO__: { version: string; commit: string; dirty: boolean; builtAt: string }

export const WEBUI_BUILD_INFO = typeof __WEBUI_BUILD_INFO__ === 'undefined'
  ? { version: 'development', commit: '', dirty: true, builtAt: '' }
  : __WEBUI_BUILD_INFO__
