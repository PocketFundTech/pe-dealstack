"use client";

/**
 * Reusable skeleton shimmer primitives.
 *
 * Mirrors skeleton.css. The base `.skeleton` class (defined in
 * globals.css) provides the gradient + shimmer animation; this component just
 * adds ergonomic React props for sizing and shape.
 *
 * Usage:
 *   <Skeleton width="60%" height={14} />
 *   <Skeleton.Line width="40%" />
 *   <Skeleton.Circle size={32} />
 *   <Skeleton.Badge />
 */

import { cn } from "@/lib/cn";
import type { CSSProperties, HTMLAttributes } from "react";

type Size = number | string;

interface SkeletonBaseProps extends HTMLAttributes<HTMLDivElement> {
  width?: Size;
  height?: Size;
  rounded?: "sm" | "md" | "lg" | "xl" | "full" | "none";
  /** Display block by default; set inline to render inside flow text (e.g. headings). */
  inline?: boolean;
}

const ROUNDED_MAP: Record<NonNullable<SkeletonBaseProps["rounded"]>, string> = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  full: "rounded-full",
};

function toCss(v: Size | undefined): string | number | undefined {
  if (v === undefined) return undefined;
  return typeof v === "number" ? `${v}px` : v;
}

function SkeletonBase({
  width,
  height,
  rounded = "md",
  inline = false,
  className,
  style,
  ...rest
}: SkeletonBaseProps) {
  const merged: CSSProperties = {
    width: toCss(width),
    height: toCss(height),
    ...style,
  };
  return (
    <div
      aria-hidden="true"
      className={cn(
        "skeleton",
        inline ? "inline-block align-middle" : "block",
        ROUNDED_MAP[rounded],
        className,
      )}
      style={merged}
      {...rest}
    />
  );
}

interface LineProps extends Omit<SkeletonBaseProps, "rounded" | "height"> {
  height?: Size;
}

function Line({ width = "60%", height = 14, className, ...rest }: LineProps) {
  return (
    <SkeletonBase
      width={width}
      height={height}
      rounded="md"
      className={className}
      {...rest}
    />
  );
}

interface CircleProps extends Omit<SkeletonBaseProps, "rounded" | "width" | "height"> {
  size?: Size;
}

function Circle({ size = 32, className, ...rest }: CircleProps) {
  return (
    <SkeletonBase
      width={size}
      height={size}
      rounded="full"
      className={cn("shrink-0", className)}
      {...rest}
    />
  );
}

type BadgeProps = Omit<SkeletonBaseProps, "rounded">;

function Badge({ width = 64, height = 20, className, ...rest }: BadgeProps) {
  return (
    <SkeletonBase
      width={width}
      height={height}
      rounded="full"
      className={className}
      {...rest}
    />
  );
}

/**
 * Skeleton — base shimmer rectangle with optional w/h/rounded props.
 * Sub-components for common shapes are attached as static members.
 *
 * ⚠️ RSC boundary: the `.Line` / `.Circle` / `.Badge` static members only
 * resolve inside the CLIENT graph. This is a `"use client"` module, so a
 * Server Component that does `<Skeleton.Line/>` gets a client *reference* for
 * `Skeleton` (static members stripped) → `Skeleton.Line` is undefined →
 * React #130 on render. Any `loading.tsx` / server component using the
 * compound sub-components must declare `"use client"` (plain `<Skeleton/>` is
 * fine either way).
 */
export const Skeleton = Object.assign(SkeletonBase, {
  Line,
  Circle,
  Badge,
});

export type { SkeletonBaseProps as SkeletonProps };
