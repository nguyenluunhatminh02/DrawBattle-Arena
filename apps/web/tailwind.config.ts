import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    screens: {
      xs: '480px',
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        arena: {
          950: 'hsl(var(--arena-950))',
          900: 'hsl(var(--arena-900))',
          800: 'hsl(var(--arena-800))',
        },
        panel: {
          DEFAULT: 'hsl(var(--panel))',
          border: 'hsl(var(--panel-border))',
        },
        paper: {
          DEFAULT: 'hsl(var(--paper))',
          mat: 'hsl(var(--paper-mat))',
          ink: 'hsl(var(--ink))',
        },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        'team-a': 'hsl(var(--team-a))',
        'team-b': 'hsl(var(--team-b))',
        'accent-on-arena': 'hsl(var(--accent-on-arena))',
        'danger-on-arena': 'hsl(var(--danger-on-arena))',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        panel: '0 18px 60px -28px hsl(255 80% 4% / 0.85)',
        paper: '0 10px 35px -18px hsl(255 80% 6% / 0.7)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
