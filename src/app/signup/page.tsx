"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteLayout from "../components/SiteLayout";

export default function SignupPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (loading) return;

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, username }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);

        setError(
          typeof data?.error?.message === "string"
            ? data.error.message
            : "Unable to create your account. Check your details and try again.",
        );
        return;
      }

      const data = await response.json();

      if (data.data.status === "confirmation_required") {
        setMessage(
          "Check your email for a confirmation link before signing in.",
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

  const inputClassName =
    "h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/25";

  return (
    <SiteLayout>
      <section
        aria-labelledby="signup-heading"
        className="mx-auto flex w-full max-w-5xl flex-col items-center"
      >
        <h1
          id="signup-heading"
          className="text-center text-3xl font-bold tracking-tight text-primary sm:text-4xl"
        >
          Create your account.
        </h1>

        <p className="mt-3 text-center text-sm text-secondary">
          Start your music development journey today.
        </p>

        <div className="relative isolate mt-8 flex w-full justify-center py-6 sm:mt-10 sm:py-10">
          {/* Decorative music graphic */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center overflow-hidden"
          >
            <div
              className="h-full w-full max-w-[700px] bg-secondary opacity-30"
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
            className="w-full max-w-[360px] space-y-6 rounded-3xl bg-white px-6 py-8 text-[#1f2328] shadow-[0_16px_32px_rgba(0,0,0,0.18)] sm:px-8 sm:py-10"
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
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClassName}
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
                name="password"
                type="password"
                placeholder="Create a password"
                autoComplete="new-password"
                aria-describedby="password-help"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClassName}
              />

              <p
                id="password-help"
                className="mt-2 text-xs leading-5 text-gray-600"
              >
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
                name="username"
                type="text"
                placeholder="Choose a username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className={inputClassName}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}

            {message && (
              <p role="status" className="text-sm text-green-700">
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="h-11 w-full rounded-lg bg-secondary text-base font-semibold text-white transition hover:bg-secondary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:cursor-wait disabled:opacity-60"
            >
              {loading ? "Creating account..." : "Create Account"}
            </button>

            <p className="text-xs leading-5 text-gray-600">
              By creating an account, you agree to our{" "}
              <a
                href="#"
                className="text-secondary underline underline-offset-2"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                href="#"
                className="text-secondary underline underline-offset-2"
              >
                Privacy Policy
              </a>
              .
            </p>

            <p className="text-center text-xs leading-6">
              Already have an account?{" "}
              <Link
                href="/login"
                className="text-secondary underline underline-offset-2"
              >
                Sign in
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