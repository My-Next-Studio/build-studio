# Knowledge Manifest Specification

**Status:** v1 (`contract: 1`) · **Shared by all Studio applications** — Build
Studio produces manifests for the projects it manages; any other Studio
application (or a human) produces them for repos Build Studio doesn't manage.

## Purpose

The *knowledge folder* of a product is **logical, not physical**: the set of
paths declared by manifests, not a fixed directory tree. The manifest is the
binding piece of the file contract — it tells any consumer (another Studio
application, an external agent) **where** each kind of product knowledge lives,
**who owns** each path, and **which products** a repo serves, without the
consumer assuming a layout.

A repo's internal layout stays free to evolve; the manifest is the stable,
versioned surface.

## File

One file per repo (or plain folder — git is recommended, not required):

```
docs/knowledge.yaml
```

## Schema

```yaml
contract: 1                     # spec version of this file

products:                       # every product this repo holds knowledge for
  - id: example-app             # stable slug — matches the product registry
    name: Example App
    knowledge:                  # knowledge type → path (file or dir, repo-relative)
      vision: docs/vision.md
      project_state: docs/project-state.md
      architecture: ARCHITECTURE.md
      prds: docs/prds/
      backlog: docs/backlog/
      learnings: docs/learnings/
      asset_register: docs/asset-register.md
      positioning: docs/marketing/positioning.md
      marketing_content: docs/marketing/content/

shared:                         # optional: family-level knowledge, inherited by
  brand_voice: docs/brand/voice.md   # every product above; per-product keys win
  brand_assets: public/brand/

owners:                         # which Studio application maintains which paths
  build-studio:
    - docs/prds/
    - docs/backlog/
    - docs/learnings/
    - docs/vision.md
  launch-studio:
    - docs/marketing/
```

### Knowledge type keys

Well-known keys (consumers may rely on these names): `vision`,
`project_state`, `architecture`, `inputs`, `prds`, `backlog`, `learnings`,
`asset_register`, `adrs`, `brand`, `ux`, `runbooks`, `positioning`,
`personas`, `brand_voice`, `channel_plan`, `keywords`, `marketing_content`,
`journal`, `newsletter`, `landing`, `aso_metadata`, `strategy`.

Unknown keys are allowed — the vocabulary grows from use. Paths are
repo-relative; a trailing `/` marks a directory.

## Rules

1. **Uniqueness.** Across *all* repos of a product, each `(product id,
   knowledge type)` pair resolves to exactly **one** canonical path. Consumers
   validate at onboarding; a collision is an error, never a merge.
2. **Ownership is per path, one owner each.** Applications write only inside
   paths they own; everything else they read and reference. An application
   claims paths by adding itself under `owners:` when it starts managing a
   repo.
3. **Shared scope.** `shared:` keys apply to every product in the manifest;
   a product-level key of the same name overrides for that product. This is
   for product *families* (one brand kit serving several apps).
4. **Knowledge home.** A product with several repos designates one as its
   *knowledge home* (where its positioning/marketing knowledge lives). The
   designation lives in the consuming application's product registry, not in
   the manifest — a repo describes itself; the registry stitches.
5. **Honesty.** Manifests map what exists (plus paths an owner is about to
   create). They are not aspirations; a consumer must be able to read every
   declared path or know the owner is creating it.
6. **Versioning.** Breaking schema changes bump `contract:`. Consumers must
   ignore keys they don't understand within a version.

## Runtime state is not knowledge

Workflow state, snapshots, queues, caches, and secrets are never declared in a
manifest. Secrets follow the asset-register rule: references to a secret
manager only.

## Examples

**Single-product project (the scaffold default):** see the template written by
`build-studio init` — one product, the standard docs layout, `build-studio` as
owner.

**Multi-product repo:** a marketing-site repo can serve the studio itself plus
several app products (fragments: per-product positioning and landing content),
with the family brand kit under `shared:`. The apps' *code* repo then carries a
minimal manifest (or none), and the consuming registry marks the site repo as
those products' knowledge home.
