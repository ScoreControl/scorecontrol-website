"use client";

import { useState } from "react";
import Link from "next/link";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");

  return (
    <main className="flex min-h-screen flex-col items-center bg-[#f6f8fa] px-4 py-10 text-[#1f2328]">
      <Link
        href="/"
        className="mb-6 flex items-center gap-2 text-2xl font-semibold tracking-tight"
      >
        ScoreControl
      </Link>

      <h1 className="mb-3 text-2xl font-normal text-center">
        Create your account
      </h1>

      <p className="mb-6 max-w-md text-center text-sm leading-6 text-[#59636e]">
        Start your music development journey today.
      </p>

      <form
        className="w-full max-w-[340px] space-y-4 rounded-lg border border-[#d1d9e0] bg-white p-5"
      >
        <div>
          <label
            htmlFor="email"
            className="mb-2 block text-sm font-medium"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-[#d1d9e0] px-3 py-2 text-sm outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-2 block text-sm font-medium"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            placeholder="Create a password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-[#d1d9e0] px-3 py-2 text-sm outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20"
          />
          <p className="mt-2 text-xs leading-5 text-[#59636e]">
            Use a strong password to protect your account.
          </p>
        </div>

        <div>
          <label
            htmlFor="username"
            className="mb-2 block text-sm font-medium"
          >
            Username
          </label>
          <input
            id="username"
            type="text"
            placeholder="Choose a username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-md border border-[#d1d9e0] px-3 py-2 text-sm outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-md border border-[#1f883d] bg-[#1f883d] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1a7f37] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0969da] focus-visible:ring-offset-2"
        >
          Create account
        </button>

        <p className="pt-1 text-xs leading-5 text-[#59636e]">
          By creating an account, you agree to our{" "}
          <a href="#" className="text-[#0969da] hover:underline">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="#" className="text-[#0969da] hover:underline">
            Privacy Policy
          </a>.
        </p>
      </form>

      <div className="mt-4 w-full max-w-[340px] rounded-lg border border-[#d1d9e0] bg-white p-4 text-center text-sm">
        Already have an account?{" "}
        <Link href="/login" className="text-[#0969da] hover:underline">
          Sign in
        </Link>
      </div>

      <footer className="mt-10 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-[#59636e]">
        <a href="#" className="hover:text-[#0969da]">Terms</a>
        <a href="#" className="hover:text-[#0969da]">Privacy</a>
        <a href="#" className="hover:text-[#0969da]">Contact</a>
      </footer>
    </main>
  );
}