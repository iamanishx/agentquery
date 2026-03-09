# AgentQuery

Ask questions about your PostgreSQL database in plain English. AgentQuery figures out the schema, writes the SQL, and shows you the results - you stay in control of what actually runs.

Live at: https://agentquery.vercel.app/

## What it does

- Connects to any PostgreSQL database (connection string or individual fields)
- Uses an AI agent to explore your schema and propose read-only queries
- Shows 2-3 query options so you can pick, edit, then run
- Renders results as a data grid and bar chart, with CSV export
- Supports OpenAI and Google Gemini - bring your own API key

Everything is local. Credentials and chat history live in IndexedDB in your browser, API keys included.

## Getting started

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, add a database connection, drop in your API key from the Settings icon, and start asking questions.

## Stack

- Next.js 14, React 18, Tailwind CSS
- Vercel AI SDK (`generateText` + `generateObject`)
- `postgres` driver, `idb` for local storage, `recharts` for charts
