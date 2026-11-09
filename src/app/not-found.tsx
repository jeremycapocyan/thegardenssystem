import Link from "next/link";
export default function NotFound() {
  return (
    <main className="loading-screen">
      <h1>This page isn’t on the court.</h1>
      <p>Go back to your finance overview.</p>
      <Link className="button primary" href="/">
        Back to overview
      </Link>
    </main>
  );
}
