import Link from "next/link";

type AccountPage =
  | "reviewer"
  | "factory_manager"
  | "signup"
  | "reviewer-request";

const links: { page: AccountPage; href: string; label: string }[] = [
  {
    page: "factory_manager",
    href: "/?sign-in=factory-manager",
    label: "Factory Manager sign-in",
  },
  {
    page: "signup",
    href: "/signup/factory-manager",
    label: "Factory Manager signup",
  },
  { page: "reviewer", href: "/", label: "Reviewer / Auditor sign-in" },
  {
    page: "reviewer-request",
    href: "/signup/reviewer",
    label: "Request reviewer access",
  },
];

export function AccountMenu({ current }: { current: AccountPage }) {
  return (
    <nav className="account-menu" aria-label="Account options">
      {links.map(({ page, href, label }) => (
        <Link
          key={page}
          href={href}
          aria-current={page === current ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
