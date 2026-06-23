/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/index.html",
    "./src/renderer/src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        surface: 'var(--surface)',
        'surface-dim': 'var(--surface-dim)',
        'surface-bright': 'var(--surface-bright)',
        'surface-lowest': 'var(--surface-lowest)',
        'surface-low': 'var(--surface-low)',
        'surface-container': 'var(--surface-container)',
        'surface-high': 'var(--surface-high)',
        'surface-highest': 'var(--surface-highest)',
        primary: 'var(--primary)',
        'on-primary': 'var(--on-primary)',
        'primary-container': 'var(--primary-container)',
        secondary: 'var(--secondary)',
        'on-secondary': 'var(--on-secondary)',
        'secondary-container': 'var(--secondary-container)',
        tertiary: 'var(--tertiary)',
        'on-tertiary': 'var(--on-tertiary)',
        'tertiary-container': 'var(--tertiary-container)',
        error: 'var(--error)',
        'on-error': 'var(--on-error)',
        warning: 'var(--warning)',
        'on-warning': 'var(--on-warning)',
        'on-surface': 'var(--on-surface)',
        'on-surface-variant': 'var(--on-surface-variant)',
        outline: 'var(--outline)',
        'outline-variant': 'var(--outline-variant)',
        // 微信风格 UI 专属颜色
        'nav-bar': 'var(--nav-bar)',
        'nav-border': 'var(--nav-border)',
        'nav-icon': 'var(--nav-icon)',
        'nav-icon-hover': 'var(--nav-icon-hover)',
        'nav-icon-hover-bg': 'var(--nav-icon-hover-bg)',
        'nav-icon-active-bg': 'var(--nav-icon-active-bg)',
        'nav-avatar-border': 'var(--nav-avatar-border)',
        sidebar: 'var(--sidebar)',
        'sidebar-border': 'var(--sidebar-border)',
        'chat-bg': 'var(--chat-bg)',
        'chat-header': 'var(--chat-header)',
        'chat-border': 'var(--chat-border)',
        'chat-input-bg': 'var(--chat-input-bg)',
        'chat-input-border': 'var(--chat-input-border)',
        'user-bubble': 'var(--user-bubble)',
        'user-bubble-text': 'var(--user-bubble-text)',
        'ai-bubble': 'var(--ai-bubble)',
        'ai-bubble-text': 'var(--ai-bubble-text)',
        'conversation-hover': 'var(--conversation-hover)',
        'conversation-selected': 'var(--conversation-selected)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-default)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)'
      }
    },
  },
  plugins: [],
}
