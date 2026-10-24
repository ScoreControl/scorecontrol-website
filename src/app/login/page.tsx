"use client";

import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: email,
          password,
          rememberMe: false,
        }),
      });

      if (!response.ok) {
        setError("Unable to sign in. Check your details and try again.");
        return;
      }

      window.location.assign("/");
    } catch {
      setError("Could not connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="flex min-h-screen flex-col items-center bg-[#f6f8fa] px-4 py-10 text-[#1f2328]">
      <Link href="/" className="mb-6 text-2xl font-semibold tracking-tight">
        ScoreControl
      </Link>

      <h1 className="mb-5 text-2xl font-normal">
        Sign in to ScoreControl
      </h1>

      <form
        onSubmit={handleSubmit} 
        className="w-full max-w-[340px] space-y-4 rounded-lg border border-[#d1d9e0] bg-white p-5"
      >
        <div>
          <label htmlFor="email" className="mb-2 block text-sm font-medium">
            Username or email address
          </label>
          <input
            id="email"
            type="text"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-[#d1d9e0] px-3 py-2 text-sm outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20"
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <button
              type="button"
              className="text-xs text-[#0969da] hover:underline"
            >
              Forgot password?
            </button>
          </div>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-[#d1d9e0] px-3 py-2 text-sm outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20"
          />
        </div>

        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {message && <p role="status" className="text-sm text-green-700">{message}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md border border-[#1f883d] bg-[#1f883d] px-3 py-2 text-sm font-medium text-white hover:bg-[#1a7f37]"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <div className="mt-4 w-full max-w-[340px] rounded-lg border border-[#d1d9e0] bg-white p-4 text-center text-sm">
        New to ScoreControl?{" "}
        <Link href="/signup" className="text-[#0969da] hover:underline">
          Create an account
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