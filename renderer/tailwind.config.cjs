const path = require('path');

module.exports = {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{vue,ts,js,jsx,tsx}'),
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Segoe UI"', 'system-ui', 'sans-serif'],
        display: ['"Segoe UI Semibold"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"SFMono-Regular"', 'Consolas', 'monospace'],
      },
      colors: {
        ink: {
          950: '#040816',
          900: '#08101f',
          800: '#0d172b',
        },
        mint: {
          300: '#91f7da',
          400: '#47e8c2',
        },
        sky: {
          300: '#95d8ff',
          400: '#67b8ff',
        },
        amber: {
          300: '#ffd27a',
          400: '#ffb84d',
        },
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,255,255,0.06), 0 28px 90px rgba(3, 8, 25, 0.62)',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translate3d(0, 0, 0)' },
          '50%': { transform: 'translate3d(0, -10px, 0)' },
        },
        drift: {
          '0%, 100%': { transform: 'translate3d(0, 0, 0)' },
          '33%': { transform: 'translate3d(10px, -8px, 0)' },
          '66%': { transform: 'translate3d(-8px, 10px, 0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-120% 0' },
          '100%': { backgroundPosition: '120% 0' },
        },
        glowPulse: {
          '0%, 100%': { opacity: '0.34', filter: 'blur(16px)' },
          '50%': { opacity: '0.56', filter: 'blur(22px)' },
        },
      },
      animation: {
        float: 'float 8s ease-in-out infinite',
        drift: 'drift 14s ease-in-out infinite',
        shimmer: 'shimmer 2.8s linear infinite',
        'glow-pulse': 'glowPulse 6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
