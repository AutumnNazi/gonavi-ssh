import type { ITheme, ITerminalOptions } from '@xterm/xterm'
import type { HostPrefs } from './hostPrefs'

function rgb(color: string): number[] | undefined {
  const hex = /^#([a-f\d]{6})$/i.exec(color)
  if (hex) return [0, 2, 4].map(index => parseInt(hex[1].slice(index, index + 2), 16))
  const channels = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(color)
  if (channels) return [...channels.slice(1, 4).map(Number), channels[4] === undefined ? 1 : Number(channels[4])]
  const context = document.createElement('canvas').getContext?.('2d')
  if (!context) return undefined
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const pixel = [...context.getImageData(0, 0, 1, 1).data]
  return [...pixel.slice(0, 3), pixel[3] / 255]
}

function contrast(a: number[], b: number[]): number {
  const luminance = (value: number[]) => value.slice(0, 3).map(channel => {
    const s = channel / 255
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
  const first = luminance(a), second = luminance(b)
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05)
}

export function terminalOptions(prefs: HostPrefs): ITerminalOptions {
  const terminalTheme: ITheme = prefs.theme === 'dark' ? {
    background: '#1e1e1e', foreground: '#e5e7eb', cursor: '#f3f4f6', cursorAccent: '#1e1e1e',
    selectionBackground: '#365b85', selectionInactiveBackground: '#3f5268', selectionForeground: '#ffffff',
    black: '#969696', red: '#ff8080', green: '#8bd49c', yellow: '#f0cc76',
    blue: '#82b4ff', magenta: '#d5a0ee', cyan: '#72d5dc', white: '#d5d9e0',
    brightBlack: '#b0b0b0', brightRed: '#ffa0a0', brightGreen: '#a7e8b4', brightYellow: '#ffe09a',
    brightBlue: '#a7caff', brightMagenta: '#e5b8fa', brightCyan: '#9ce8ee', brightWhite: '#ffffff',
  } : {
    background: '#ffffff', foreground: '#202124', cursor: '#202124', cursorAccent: '#ffffff',
    selectionBackground: '#b8d6ff', selectionInactiveBackground: '#cbd5e1', selectionForeground: '#111827',
    black: '#202124', red: '#b42318', green: '#176b35', yellow: '#805500',
    blue: '#1750ad', magenta: '#8534a3', cyan: '#006b75', white: '#525861',
    brightBlack: '#666666', brightRed: '#c12f24', brightGreen: '#227a3f', brightYellow: '#906300',
    brightBlue: '#245fc1', brightMagenta: '#9545b4', brightCyan: '#007b86', brightWhite: '#686868',
  }
  const palette = prefs.palette
  const background = palette?.code ?? terminalTheme.background!
  const foreground = palette?.text ?? terminalTheme.foreground!
  const theme = { ...terminalTheme, background, foreground, cursor: foreground, cursorAccent: background }
  if (palette?.accentSoft) {
    theme.selectionBackground = palette.accentSoft
    theme.selectionInactiveBackground = palette.accentSoft
    const selection = rgb(palette.accentSoft)
    const base = rgb(background)
    if (selection && base) {
      const opacity = selection[3] ?? 1
      const selectionColor = 'rgba(' + selection.slice(0, 3).join(', ') + ', ' + opacity + ')'
      theme.selectionBackground = selectionColor
      theme.selectionInactiveBackground = selectionColor
      const composite = selection.slice(0, 3).map((channel, index) => channel * opacity + base[index] * (1 - opacity))
      theme.selectionForeground = contrast([0, 0, 0], composite) >= contrast([255, 255, 255], composite) ? '#000000' : '#ffffff'
    }
  }
  const bg = rgb(background)
  if (bg && palette?.code) {
    const target = contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? [0, 0, 0] : [255, 255, 255]
    const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
    for (const key of keys) {
      const source = rgb(theme[key]!)!.slice(0, 3)
      let adjusted = source
      for (let step = 1; contrast(adjusted, bg) < 4.5 && step <= 100; step++) {
        adjusted = source.map((channel, index) => Math.round(channel + (target[index] - channel) * step / 100))
      }
      theme[key] = '#' + adjusted.map(channel => channel.toString(16).padStart(2, '0')).join('')
    }
  }
  return { theme, fontFamily: prefs.appearance?.monoFontFamily ?? 'Consolas, "Courier New", monospace', fontSize: prefs.appearance?.monoFontSize ?? 13 }
}
