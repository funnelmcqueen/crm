import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { resolveLocale } from "@/lib/i18n/locales";
import { cookies } from "next/headers";
import "./globals.css";

// `--font-sans` is the variable the shadcn theme in globals.css maps to Tailwind's font-sans.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Funnel McQueen CRM",
    template: "%s | Funnel McQueen CRM",
  },
  description: "Cold-calling CRM for the Funnel McQueen sales team.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#1a1a1a",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = resolveLocale((await cookies()).get("crm_locale")?.value);
  return (
    <html lang={locale} className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <LocaleProvider locale={locale}><TooltipProvider>{children}</TooltipProvider></LocaleProvider>
        <Toaster theme="dark" position="top-center" />
      </body>
    </html>
  );
}
