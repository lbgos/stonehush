import { Link, useRouterState } from "@tanstack/react-router";

interface RoutePageProps {
  description: string;
  eyebrow: string;
  title: string;
}

export function RoutePage({ description, eyebrow, title }: RoutePageProps) {
  return (
    <main className="min-h-full bg-background px-4 py-5 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <p className="m-0 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
          {eyebrow}
        </p>
        <h1 className="mt-2 mb-0 text-[26px] leading-none font-semibold tracking-[-0.04em]">
          {title}
        </h1>
        <p className="mt-2 mb-0 max-w-xl text-[13px] leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
    </main>
  );
}

export function UnknownRoutePage() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <main className="min-h-full bg-background px-4 py-5 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <p className="m-0 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
          Unknown route
        </p>
        <h1 className="mt-2 mb-0 text-[26px] leading-none font-semibold tracking-[-0.04em]">
          Page not found
        </h1>
        <p className="mt-2 mb-0 max-w-xl text-[13px] leading-5 text-muted-foreground">
          Stonehush does not have a page at <code className="font-mono">{pathname}</code>.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground outline-none hover:brightness-[1.06] focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
        >
          Return to Dashboard
        </Link>
      </div>
    </main>
  );
}
