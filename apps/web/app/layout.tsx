import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './styles.css';
import './tailwind.css';

export const metadata: Metadata = {
  title: 'Watchrail',
  description: 'Open-source uptime monitoring for developers and small teams.',
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#181818' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
