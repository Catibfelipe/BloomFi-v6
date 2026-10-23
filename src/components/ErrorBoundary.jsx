import React from 'react';
import Wally from './Wally.jsx';

/**
 * A screen that throws while drawing shows a way out instead of a blank app: try again, go Home, or open Family
 * (where a space with broken shared data can be checked or left). The menus around it keep working.
 */
export class PageBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[page]', error?.message || error); }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    const { t, go, hasSpaces } = this.props;
    return (
      <section className="panel page-error" role="alert">
        <Wally mood="worried" size={64} />
        <h2>{t('err.pageTitle')}</h2>
        <p className="muted">{t('err.pageText')}</p>
        {hasSpaces && <p className="hint">{t('err.pageSpace')}</p>}
        <div className="btn-col">
          <button className="primary" onClick={() => this.setState({ failed: false })}>{t('err.retry')}</button>
          <button className="ghost" onClick={() => go('home')}>{t('err.home')}</button>
          {hasSpaces && <button className="ghost" onClick={() => go('space')}>{t('err.space')}</button>}
        </div>
      </section>
    );
  }
}

/** Last line of defence (outside the app's own state): a short message and a reload button. */
export class AppBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[app]', error?.message || error); }
  render() {
    if (!this.state.failed) return this.props.children;
    const en = (navigator.language || '').toLowerCase().startsWith('en');
    return (
      <div className="fatal" role="alert">
        <h1>{en ? 'Something went wrong' : 'Algo deu errado'}</h1>
        <p>{en ? 'Your data is still safe on this device. Reload to open BloomFi again.' : 'Seus dados continuam guardados neste aparelho. Recarregue para abrir o BloomFi de novo.'}</p>
        <button className="primary" onClick={() => window.location.reload()}>{en ? 'Reload' : 'Recarregar'}</button>
      </div>
    );
  }
}
