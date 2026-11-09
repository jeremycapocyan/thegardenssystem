import type { Metadata } from "next";
import { WorkspaceProvider } from "@/components/workspace-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "The Gardens · Court Finance",
    template: "%s · The Gardens",
  },
  description:
    "A shared finance workspace for The Gardens pickleball court. Daily income, expenses, installments, and owner settlements.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </body>
    </html>
  );
}
