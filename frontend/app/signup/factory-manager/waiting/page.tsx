export default function Waiting() {
  return (
    <main className="entry-page">
      <section className="panel entry-panel">
        <h1>Application submitted</h1>
        <p>
          Your application is waiting for admin approval. Try logging in later
          to check the result.
        </p>
        <a href="/login">Back to sign in</a>
      </section>
    </main>
  );
}
