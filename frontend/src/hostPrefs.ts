// 宿主在入口脚本前安装安全偏好；变化时更新 global 并发送 gonavi:host-preferences。
// 不保存本地主题选择，无宿主注入时使用浏览器语言与浅色默认值。
export type HostTheme = 'light' | 'dark'
export type HostPalette = Partial<Record<'bg' | 'panel' | 'input' | 'code' | 'text' | 'muted' | 'border' | 'border1' | 'accent' | 'accentSoft' | 'ok' | 'warn' | 'warnBg' | 'chip' | 'hover', string>>

export interface HostAppearance {
  fontFamily?: string;
  monoFontFamily?: string;
  fontSize?: number;
  monoFontSize?: number;
  radius?: number;
  opacity?: number;
  background?: { enabled: boolean; tint?: number };
}

export function sanitizeHostAppearance(value: unknown): HostAppearance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const appearance: HostAppearance = {};
  for (const key of ['fontFamily', 'monoFontFamily'] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const font = source[key];
    if (typeof font !== 'string' || !font.trim() || font.length > 512
      || /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(font.trim())
      || /[\\;<>@\x00-\x1f\x7f]|(?:url|var|env|expression)\s*\(/i.test(font)
      || !/^(?:\s*(?:"[^"\\]+"|'[^'\\]+'|[-\w ]+)\s*)(?:,\s*(?:"[^"\\]+"|'[^'\\]+'|[-\w ]+)\s*)*$/.test(font)
      || typeof document === 'undefined') continue;
    const style = document.createElement('span').style;
    style.fontFamily = font;
    if (style.fontFamily && style.fontFamily.length <= 512) appearance[key] = style.fontFamily;
  }
  for (const [key, min, max] of [['fontSize', 8, 48], ['monoFontSize', 8, 48], ['radius', 0, 32], ['opacity', .1, 1]] as const) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const number = source[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= min && number <= max) appearance[key] = number;
  }
  const background = Object.prototype.hasOwnProperty.call(source, 'background') ? source.background : undefined;
  if (background && typeof background === 'object' && !Array.isArray(background)) {
    const raw = background as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(raw, 'enabled') && typeof raw.enabled === 'boolean') {
      appearance.background = { enabled: raw.enabled };
      if (Object.prototype.hasOwnProperty.call(raw, 'tint') && typeof raw.tint === 'number' && Number.isFinite(raw.tint) && raw.tint >= .7 && raw.tint <= .95) appearance.background.tint = raw.tint;
    }
  }
  return Object.keys(appearance).length ? appearance : undefined;
}

export function sanitizeHostPalette(value: unknown): HostPalette | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof document === 'undefined') return undefined;
  const palette: HostPalette = {};
  const style = document.createElement('span').style;
  const keys = ['bg', 'panel', 'input', 'code', 'text', 'muted', 'border', 'border1', 'accent', 'accentSoft', 'ok', 'warn', 'warnBg', 'chip', 'hover'] as const;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const color = (value as Record<string, unknown>)[key];
    if (typeof color !== 'string' || color.length > 128) continue;
    const trimmed = color.trim();
    if (!trimmed || /[\\;<>\x00-\x1f\x7f]|(?:url|var|expression)\s*\(/i.test(trimmed)) continue;
    if (!/^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|hwb|color|lab|lch|oklab|oklch)\([\w\s.,%+\/-]+\))$/i.test(trimmed)) continue;
    if (/^color\(/i.test(trimmed) && !/^color\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\s/i.test(trimmed)) continue;
    style.color = '';
    style.color = trimmed;
    if (style.color && style.color.length <= 128) palette[key] = style.color;
  }
  return Object.keys(palette).length ? palette : undefined;
}

export interface HostPrefs {
  locale: string
  theme: HostTheme
  palette?: HostPalette
  appearance?: HostAppearance
}

declare global {
  interface Window {
    gonaviHostPrefs?: { locale?: unknown; theme?: unknown; palette?: unknown; appearance?: unknown }
  }
}

function resolveHostPrefs(): HostPrefs {
  const raw = window.gonaviHostPrefs
  const locale = typeof raw?.locale === 'string' && /^[a-zA-Z-]{2,32}$/.test(raw.locale)
    ? raw.locale
    : navigator.language || 'zh-CN'
  const theme: HostTheme = raw?.theme === 'dark' ? 'dark' : 'light'
  const palette = sanitizeHostPalette(raw?.palette)
  const appearance = sanitizeHostAppearance(raw?.appearance)
  return { locale, theme, ...(palette ? { palette } : {}), ...(appearance ? { appearance } : {}) }
}

export let hostPrefs: HostPrefs = resolveHostPrefs()
export let isDark = hostPrefs.theme === 'dark'

export function subscribeHostPrefs(listener: (prefs: HostPrefs) => void): () => void {
  const update = () => {
    hostPrefs = resolveHostPrefs()
    isDark = hostPrefs.theme === 'dark'
    listener(hostPrefs)
  }
  window.addEventListener('gonavi:host-preferences', update)
  return () => window.removeEventListener('gonavi:host-preferences', update)
}

export function hostLanguage(): 'zh' | 'en' {
  return hostPrefs.locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
