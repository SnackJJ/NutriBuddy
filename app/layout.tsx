import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NutriBuddy",
  description: "AI 营养助手 — 自建 agent harness + Next.js + Supabase",
  applicationName: "NutriBuddy",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "NutriBuddy",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/** viewport-fit=cover for iOS notch / home indicator (issue #83). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="overflow-x-hidden antialiased">{children}</body>
    </html>
  );
}
