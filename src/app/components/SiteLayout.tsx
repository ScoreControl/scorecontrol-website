// SiteLayout.tsx
import type { ReactNode } from "react";
import Navbar from "./Navbar";

export default function SiteLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#d9d9d9]">
      <Navbar />
      <main className="px-4 py-10 sm:px-6">{children}</main>
    </div>
  );
}