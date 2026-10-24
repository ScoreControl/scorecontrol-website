import Image from "next/image";
import Link from "next/link";
import { createReadOnlyClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createReadOnlyClient();
  const {data, error } = await supabase.auth.getUser();
  const user = error ? null : data.user;
  return (
    <main className="flex min-h-screen flex-col items-center bg-[#f6f8fa] px-4 py-10 text-[#1f2328]">
          <Link href="/" className="mb-6 text-2xl font-semibold tracking-tight">
            ScoreControl
          </Link>
    
          <h1 className="mb-5 text-2xl font-normal">
            hello! we currently haven't made a design page or a main page, so this is here temporarily! :D
          </h1>

          { user ? (
            <>
              <p> You are signed in! </p>
              <p className="text-sm"> useremail: {user.email}</p>
              <p className="text-sm"> username: {user.user_metadata?.scorecontrol_username ?? "Not set :("}</p>
            </>
          ) : (
            <>
              <p> You are not signed in!</p>
              <p className="text-sm"> sign in. now. the button is right there.</p>
            </>
          ) 
          }
         
    
          <div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
          <Link
            href="/login"
            className="rounded-lg bg-blue-600 px-6 py-3 text-white hover:bg-blue-700"
          >
            Log In
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
