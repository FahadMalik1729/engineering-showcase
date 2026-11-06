# Code Review Checklist

Use this checklist when reviewing a PR. Reviewers should be able to answer
"yes" (or "n/a") to every relevant question before approving.

> **Companion documents:** [`architecture.md`](./architecture.md) for the
> layering and folder philosophy, [`auth-and-session.md`](./auth-and-session.md)
> for auth flows, [`adding-a-new-feature.md`](./adding-a-new-feature.md)
> for the "how do I build a feature" recipe,
> [`responsive-layout.md`](./responsive-layout.md) for the layout
> primitives and composition rules (referenced by §7 below),
> [`data-testid.md`](./data-testid.md) for the QA automation ID convention.

---

## 1. Architecture & boundaries

- [ ] New code lives in the correct layer (`app/`, `pages/`, `features/`,
      `shared/*`) — see [`architecture.md` §2](./architecture.md#2-top-level-source-layout).
- [ ] No cross-layer violations: `shared/*` doesn't import from
      `features/*` or `app/*`; `features/*` doesn't import from `app/*`
      or `pages/*`; feature-to-feature imports go through the barrel
      only.
- [ ] Feature-internal files are NOT imported from outside the feature —
      only the barrel (`features/<x>/index.ts`) is public.
- [ ] Components inside a feature reference each other by relative path;
      pages reference feature components by `@/features/<x>/components/…`.
- [ ] No new folders in `app/components/` that aren't shell chrome
      (header, sidebar, nav, user menu, language switcher).

## 2. React & rendering discipline

- [ ] Render functions are pure — no `fetch`, no `setState`, no DOM
      writes, no `console.log`, no redirects in the function body.
- [ ] All side effects live inside `useEffect` with correct dep arrays.
- [ ] StrictMode-safe: any "run once" logic uses a `useRef` guard;
      effects have cleanups where needed.
- [ ] No `useEffect` doing what a plain derivation could do (memoize
      only when profiling says so).
- [ ] No `key={index}` unless the list is truly static.
- [ ] No effect chains (`useEffect` that sets state to trigger another
      `useEffect`) — collapse into one derivation or one effect.

## 3. Data layer (server state)

- [ ] Every fetch goes through `shared/api/httpClient`. No direct
      `fetch(...)` anywhere in `features/*` or `pages/*`.
- [ ] Every server response is Zod-parsed at the boundary — the schema
      lives in `features/<x>/schemas/`.
- [ ] Query keys come from the feature's `queryKeys.ts` factory — no
      inline `queryKey: ['x', 'y']` at call sites.
- [ ] Queries expose `queryOptions()` in `<name>Queries.ts` and hooks
      call `useQuery({ ...queries.X() })`.
- [ ] Every `queryFn` accepts `{ signal }` and forwards it to
      `httpClient`.
- [ ] Hooks that depend on session numerics guard with
      `enabled: organizationId !== null && userId !== null`.
- [ ] Mutations update the cache in `onSuccess` — either
      `setQueryData(key, patcher)` or `invalidateQueries({ queryKey })`,
      not both, and never neither.
- [ ] Reasoning behind non-default `staleTime` / `gcTime` is either
      obvious or commented.

## 4. URL state

- [ ] Filters, pagination, sort, bookmarkable selection are in the URL,
      not `useState`.
- [ ] Search params are Zod-parsed via a `use<Feature>Search()` hook —
      no `Number(searchParams.get('page'))` shape at call sites.
- [ ] The parsed search object is part of the TanStack Query key.
- [ ] No state duplicated between `useState` and the URL.

## 5. Forms

- [ ] Form schema in `features/<x>/schemas/<form>Schema.ts` — Zod, one
      per form.
- [ ] Validation messages are **i18n keys**, not English literals.
- [ ] Every field wired via `Controller` (not raw `register(...)`) when
      the field is a React Aria component.
- [ ] `useForm<Input, unknown, Values>` typed with both `z.input` and
      `z.output` types.
- [ ] If the underlying prop can change post-submit, form resets its
      defaults via `useEffect(() => form.reset(buildDefaults(prop)), [prop])`.
- [ ] Save button disabled unless `isDirty` (or has an equivalent guard).

## 6. UI states

- [ ] Every API-backed screen handles **Loading / Empty / Error /
      Success / Permission-denied** (see [`architecture.md` §13](./architecture.md#13-loading--error-boundaries)).
- [ ] Loading uses `<QueryBoundary>` — no open-coded
      `if (query.isPending)` checks.
- [ ] Empty state has feature-specific copy, not a generic spinner.
- [ ] Error state has a translated title and a Retry action; raw
      `error.message` is not shown as the primary message.
- [ ] 403 branches out to an inline "no access" panel, not an app-level
      redirect (that's reserved for the app-wide
      `no-provider-access` case).

## 7. Responsive layout

See [`responsive-layout.md`](./responsive-layout.md) for the full contract
(three ownership levels, twelve primitives, mobile drawer, gutter scale).
Reviewers should confirm the PR composes the primitives instead of
hand-rolling classes.

- [ ] The page wraps its content in `<PageLayout>` — no raw
      `<section class="mx-auto max-w-* px-* py-*">` at the page root.
- [ ] `PageLayout` `width` variant is appropriate for the content
      (`standard` for forms/detail, `wide` for dashboards/lists,
      `full` for dense workspaces).
- [ ] Shell gutters (`px-4 md:px-6 lg:px-8`) only appear in
      `AppLayout` — never re-declared in a page or feature.
- [ ] Feature sections use `<Section>` — no repeated
      `rounded-2xl border border-border bg-surface p-4 md:p-6
      shadow-sm` cards inline. No nested `<Section>`.
- [ ] Form field rows use `<FormGrid columns="one|two|three|auto">`
      instead of `<div class="grid gap-4 md:grid-cols-2">`.
- [ ] Form/action button rows use `<FormActions>` — primary action
      LAST in JSX so the mobile visual-reversal works correctly.
- [ ] Repeated tile / KPI / card lists use `<ResponsiveGrid>`.
- [ ] List/search/filter/action rows use `<Toolbar>`.
- [ ] Tables / dense data are wrapped in `<DataRegion>` so horizontal
      overflow stays inside the component, not the page.
- [ ] Long lists inside drawers / dialog bodies use `<ScrollRegion>`
      only when the surrounding surface has a genuinely bounded
      height.
- [ ] Grouped form controls with a shared label use `<FieldGroup>`.
- [ ] Mobile-first classes: base = mobile, `md:` upgrades tablet,
      `lg:` upgrades desktop. No `xl:` unless a real wide-data
      surface justifies it.
- [ ] `min-w-0` present on flex/grid children that contain truncating
      text (page titles, long org names, table cells).
- [ ] No horizontal overflow on mobile — the change was manually
      exercised at a phone width (~430 CSS px) as well as tablet
      (~768) and desktop (`>= 1024`).
- [ ] Sidebar-related state (added nav item, changed active-state
      styling) updated **once** in `sidebarItems.tsx` so both
      `AppSidebar` and `MobileNavDrawer` pick it up.
- [ ] Logical properties preferred (`ps-*` / `pe-*` / `ms-*` /
      `me-*`) over `pl-*` / `pr-*` in new Tailwind classes.
- [ ] No font-size utility scales with viewport (`text-lg` /
      `text-xl` are fixed values from the token scale — not
      `text-[3vw]`).

## 8. shared/ui component work

- [ ] Product code does NOT import from `react-aria-components` — only
      through `shared/ui/*`.
- [ ] New/changed primitive types props as `Omit<AriaXxxProps,
      'className' | 'children'> & { … }`.
- [ ] Compound children exported through `index.ts` (e.g. `Card.Header`,
      `DialogRoot`, `SelectItem`).
- [ ] All user-visible strings inside the primitive are translated under
      the `ui.*` namespace.
- [ ] Interaction states use Tailwind `data-[hovered]:` /
      `data-[pressed]:` / `data-[focus-visible]:` / `data-[selected]:` /
      `data-[invalid]:` / `data-[disabled]:` — no `useHover` /
      `useFocusRing` in the wrapper.
- [ ] Tokens (`bg-bg`, `text-fg`, `border-border`, …) used, not raw
      hex colors.
- [ ] Storybook stories cover default + variants + a11y states + at
      least one keyboard/focus/error interaction.

## 9. Auth & session

- [ ] `useAuth()` used only for identity display — sign-out flows go
      through `useSession().signOut()`.
- [ ] No feature imports `keycloak-js` directly. Token access is via
      `httpClient` only.
- [ ] Any new backend endpoint that requires the session's numeric
      context reads `organizationId` / `userId` / `roleId` from
      `useSession()`.
- [ ] If the feature affects sign-out, the composed `signOut()` order
      still runs `sessionApi.logoutSession()` before `keycloak.logout()`.

## 10. Storybook

- [ ] Every user-visible new component has a `.stories.tsx` next to it.
- [ ] Stories cover default + empty + error + variant states where they
      apply.
- [ ] MSW handlers backing the feature are added under
      `features/<x>/mocks/` and registered in
      `shared/testing/msw/handlers.ts`.
- [ ] Story-level MSW overrides (`parameters.msw.handlers`) are used
      for loading / error branches when needed.
- [ ] Page-level integration story exists (Success + Loading + Error).
- [ ] At least one `fr` locale story for components that display
      user-authored content, dates, numbers, or long labels.
- [ ] `npm run build-storybook` still passes.

## 11. i18n

- [ ] Every user-visible string routed through `t(...)`.
- [ ] Keys are stable (`profile.sections.phones.empty`), not English
      content (`no_phones_found`).
- [ ] Keys are namespaced by feature; shared UI uses `ui.*`.
- [ ] BOTH `locales/en/common.json` AND `locales/fr/common.json` have
      the new keys.
- [ ] ICU plural (`_one`/`_other`) used for counts, not string
      concatenation.
- [ ] Layout tolerates French text expansion (no fixed-width labels for
      dynamic content).
- [ ] Zod messages are i18n keys, resolved via `t(errors.field.message)`.

## 12. Accessibility

- [ ] Buttons are `<Button>`, links are `<Link>` — never a button styled
      as a link or vice versa.
- [ ] Every input has a visible label (not just a placeholder).
- [ ] Error messages associated with fields via React Aria's
      `errorMessage` prop, not just adjacent text.
- [ ] Focus outlines preserved (`focus-visible:ring-*` or equivalent).
- [ ] Semantic HTML (`<nav>`, `<main>`, `<header>`, `<footer>`) before
      `<div role="…">`.
- [ ] Storybook a11y addon shows no new violations in the story panel.

## 13. TypeScript

- [ ] Strict mode kept happy — no `any`, no unexplained
      `@ts-expect-error` / `eslint-disable`.
- [ ] `noUncheckedIndexedAccess` respected — array/object index results
      handled as `T | undefined`, not `!`-forced.
- [ ] No enabling of `exactOptionalPropertyTypes` (deliberately off).
- [ ] Every escape hatch comment (`@ts-expect-error`, `eslint-disable`)
      is next to a one-line "why" comment.
- [ ] Public types (`export type ...`) live in `schemas/` or `api/`, not
      hand-written inline.
- [ ] No new `@/` alias imports that violate the folder-boundary rules.

## 14. Build & quality gates

- [ ] `npm run typecheck` — passes.
- [ ] `npm run lint` — zero new warnings on touched files.
- [ ] `npm run build` — succeeds; per-route chunk appears for new lazy
      pages; no unexplained bundle bloat.
- [ ] `npm run build-storybook` — passes.
- [ ] `IMPLEMENTATION_PROGRESS.md` updated with a per-phase note or ADR
      if this PR introduces an architectural deviation.

## 15. Dependencies

- [ ] No new npm dependencies added without answering the five
      questions in [`architecture.md` §19](./architecture.md#19-adding-new-dependencies).
- [ ] Deps added at the correct layer (`shared/*` only if used across
      features).
- [ ] Bundle impact measured and acceptable.

---

## Optional: reviewer's smoke test

For non-trivial changes, before approving:

1. Pull the branch, `npm ci && npm run dev`.
2. Log in, navigate to the affected screen, exercise the happy path.
3. `npm run storybook`, open the new stories, verify each state
   renders as documented in the PR description.
4. Toggle to `fr` and confirm no obvious layout breakage or missing
   translations.
