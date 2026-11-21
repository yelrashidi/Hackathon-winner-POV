import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-(family-name:--brim-font-display) text-[1.75rem] leading-tight font-extrabold tracking-tight text-(--brim-heading)">
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>
      </div>
      {children}
    </div>
  );
}
