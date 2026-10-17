import Link from 'next/link';

export default function UsersPage() {
  return (
    <main>
      <h1>Users</h1>
      <Link href="/users/1">Alice</Link>
      <button>Delete user</button>
    </main>
  );
}
