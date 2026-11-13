"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteLayout from "../components/SiteLayout";

export default function LoginPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (loading) return;

    setLoading(true);
    setError("");

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
        const data = await response.json().catch(() => null);

        setError(
          typeof data?.error?.message === "string"
            ? data.error.message
            : "Unable to sign in. Check your details and try again.",
        );
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Could not connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <SiteLayout>
      <section
        aria-labelledby="login-heading"
        className="mx-auto flex w-full max-w-5xl flex-col items-center"
      >
        <h1
          id="login-heading"
          className="text-center text-3xl font-bold tracking-tight text-primary sm:text-4xl"
        >
          Sign in to ScoreControl.
        </h1>

        <div className="relative isolate mt-12 flex w-full justify-center py-6 sm:mt-14 sm:py-10">
          {/* Decorative background graphic */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center overflow-hidden"
          >
            <div
              className="h-full w-full max-w-[700px] bg-secondary"
              style={{
                maskImage: "url('/images/signin_background.png')",
                maskSize: "contain",
                maskPosition: "center",
                maskRepeat: "no-repeat",
                WebkitMaskImage: "url('/images/signin_background.png')",
                WebkitMaskSize: "contain",
                WebkitMaskPosition: "center",
                WebkitMaskRepeat: "no-repeat",
              }}
            />
          </div>

          <form
            onSubmit={handleSubmit}
            aria-busy={loading}
            className="w-full max-w-[360px] space-y-6 rounded-3xl bg-white px-6 py-8 text-[#1f2328] shadow-[0_16px_32px_rgba(0,0,0,0.50)] sm:px-8 sm:py-10"
          >
            <div>
              <label
                htmlFor="email"
                className="mb-2 block text-sm font-medium"
              >
                Username or email address
              </label>

              <input
                id="email"
                name="identifier"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/25"
              />
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="password"
                  className="text-sm font-medium"
                >
                  Password
                </label>

                {/* Connect this to your password-reset flow. */}
                <button
                  type="button"
                  className="rounded text-xs text-secondary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Forgot password?
                </button>
              </div>

              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/25"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="h-11 w-full rounded-lg bg-secondary text-base font-semibold text-white transition hover:bg-secondary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:cursor-wait disabled:opacity-60"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>

            <p className="text-center text-xs leading-6">
              New to ScoreControl?{" "}
              <Link
                href="/signup"
                className="text-secondary underline underline-offset-2"
              >
                Create an account
              </Link>
            </p>
          </form>
        </div>

        <footer className="mt-12 flex items-center justify-center gap-4 text-sm font-semibold text-secondary sm:gap-6 sm:text-base">
          <Link href="/about" className="hover:underline">
            About
          </Link>
          <span aria-hidden="true">|</span>
          <Link href="/explore" className="hover:underline">
            Explore
          </Link>
          <span aria-hidden="true">|</span>
          <Link href="/contact" className="hover:underline">
            Contact
          </Link>
        </footer>
      </section>
    </SiteLayout>
  );
}