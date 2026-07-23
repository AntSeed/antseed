import Layout from '@theme/Layout';

export default function BrandPage(): JSX.Element {
  return (
    <Layout
      title="Brand System"
      description="The current AntSeed brand system: colors, typography, motion motifs, theme behavior, and usage rules."
      wrapperClassName="brand-page-wrapper"
    >
      <iframe
        src="/brand.html"
        title="AntSeed Brand System"
        style={{
          display: 'block',
          width: '100%',
          minHeight: '100vh',
          border: 0,
          background: '#FFFEFB',
        }}
      />
    </Layout>
  );
}
