import Link from "next/link";

export default function Navbar() {
  return (
    <header className="bg-navbar-background">
      <nav
        aria-label="Main navigation"
        className="flex h-20 items-center justify-between px-4"
      >
        <Link
  href="/"
  className="relative block h-30 w-40 shrink-0 text-navbar-text focus-visible:outline-2 focus-visible:outline-offset-2"
>
  <img
    src="/images/navbar_trebleclef.png"
    alt=""
    className="absolute inset-0 h-full w-full object-contain"
  />

  <span className="absolute inset-y-0 left-[30px] right-1 flex items-center justify-center font-mono text-base hover:underline">
    Home
  </span>
</Link>
        <Link
          href="/login"
          className="font-mono text-base text-navbar-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Sign In
        </Link>
      </nav>
    </header>
  );
}