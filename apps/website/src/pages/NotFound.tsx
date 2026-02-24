import { Helmet } from 'react-helmet-async'
import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center px-5">
      <Helmet>
        <title>404 — AntSeed</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <div className="font-mono text-[120px] font-bold text-accent/20 leading-none select-none">404</div>
      <h1 className="text-2xl font-bold tracking-[-0.5px] mt-2 mb-3">Page not found</h1>
      <p className="text-sm text-text-dim mb-8 max-w-[400px]">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div className="flex gap-4">
        <Link
          to="/"
          className="font-mono text-sm font-medium px-6 py-2.5 bg-accent text-bg rounded hover:bg-accent-bright transition-all no-underline tracking-[1px]"
        >
          Home
        </Link>
        <Link
          to="/docs/intro"
          className="font-mono text-sm font-medium px-6 py-2.5 border border-border text-text rounded hover:border-accent hover:text-accent transition-all no-underline tracking-[1px]"
        >
          Docs
        </Link>
      </div>
    </div>
  )
}
