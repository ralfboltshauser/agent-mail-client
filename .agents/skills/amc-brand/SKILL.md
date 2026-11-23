---
name: amc-brand
description: Apply and maintain AMC branding when changing its logo, app icons, wordmark, brand typography, public product name, or semantic color roles.
---

# Maintain AMC branding

1. Open the [brand guide](../../../docs/brand/index.html) before changing a brand surface. The guide records approved usage. The [approved PNG](../../../docs/brand/assets/coarse-stencil.png) owns the symbol geometry and is displayed unchanged in the guide. The desktop theme owns functional UI colors.
2. Identify what changed. For symbol geometry or brand colors, trace the lockups, product icon exports, menu bar template, All Accounts mask, and public documentation using `rg` and packaging config. For wordmark changes, edit the separate wordmark outlines and regenerate both lockups. For UI color changes, update the guide only when a documented role or example changes.
3. Apply the decision at the source and update each affected consumer. Run `sh scripts/build-brand-icons.sh` on macOS to regenerate lockups and desktop exports. Derive the mark from the approved image by scaling, masking, or tinting its pixels so the silhouette and gaps stay intact. Keep the menu bar and All Accounts exports suitable for tinting. Search for the old asset or value to catch consumers that still use it.
4. Update the guide in the same change. Replace obsolete examples and point the guide at real exported artwork. Keep exploration files outside the approved asset directory so readers can identify which files to use.
5. Open the guide in both appearances and verify that the wordmark, symbol, and in-context samples load and read clearly. For icon changes, extract the packaged ICNS and check 16, 32, and 64 px plus both menu bar densities. Include the affected surfaces and verification in the change record.
