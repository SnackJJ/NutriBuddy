import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NutriBuddy",
  description: "AI 营养助手 — 自建 agent harness + Next.js + Supabase",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
