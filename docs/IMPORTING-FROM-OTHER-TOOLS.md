# Importing from tools without a connector (QA #21)

Avise doesn't connect directly to **Notion, Airtable, OneDrive, SharePoint or Xero** yet. The workaround is to export to CSV or
Excel and use the built-in imports. This text is also in the app: Help Center (Deal Management FAQ), the Documentation page
(Deal Ingestion), and a note at the top of Settings → Integrations.

| You have | Export it as | Import it with | Limits |
|---|---|---|---|
| Pipeline / deal list (Notion database, Airtable base, Excel on SharePoint/OneDrive) | CSV or .xlsx | **Deals → Import Deals**: AI maps your columns, flags duplicates | 500 rows, 5 MB per file |
| Contacts / relationships | CSV | **Contacts → Import from CSV** | 500 rows |
| Documents (CIMs, financials on OneDrive / SharePoint) | Download the files | Upload to the deal's **Data room** (financials can then be extracted) | 50 MB per file |
| Xero P&L / balance sheet / cash flow | Export the report to Excel | Upload to the deal's data room → **Extract financials** | 50 MB per file |

## How to export
- **Notion**: open the database → `⋯` (top right) → **Export** → Markdown & CSV → keep the `.csv`.
- **Airtable**: open the view → view menu (`▾` next to the view name) → **Download CSV**.
- **SharePoint / OneDrive / Excel Online**: open the sheet → **File → Save as → Download a copy** (`.xlsx`), or
  **Export → CSV** for a list.
- **Xero**: Reports → open the report (Profit and Loss, Balance Sheet, Cash Summary) → **Export → Excel**.

## Tips
- Keep one header row; column names like `Company`, `Stage`, `Revenue`, `EBITDA`, `Deal size`, `Industry` map automatically.
- Split files over 500 rows.
- Native connectors are on the roadmap (no date). Until they exist, the Settings note keeps the workaround visible.
