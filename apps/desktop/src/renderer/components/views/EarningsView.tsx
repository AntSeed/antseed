import type { ViewModelProps } from '../types';

type EarningsViewProps = {
  vm: ViewModelProps['vm'];
};

export function EarningsView({ vm }: EarningsViewProps) {
  return (
    <section id="view-earnings" className={vm.viewClass(vm.shellState.activeView === 'earnings')} role="tabpanel" data-mode="seeder">
      <div className="page-header">
        <h2>Earnings</h2>
        <div className="page-header-right">
          <div className="period-toggle">
            <button className={vm.shellState.earningsPeriod === 'day' ? 'toggle-btn active' : 'toggle-btn'} data-period="day" onClick={() => vm.setEarningsPeriod('day')}>Day</button>
            <button className={vm.shellState.earningsPeriod === 'week' ? 'toggle-btn active' : 'toggle-btn'} data-period="week" onClick={() => vm.setEarningsPeriod('week')}>Week</button>
            <button className={vm.shellState.earningsPeriod === 'month' ? 'toggle-btn active' : 'toggle-btn'} data-period="month" onClick={() => vm.setEarningsPeriod('month')}>Month</button>
          </div>
          <div id="earningsMeta" className={vm.toneClass(vm.dashboardData.earnings.ok ? 'active' : 'warn')}>{vm.shellState.earningsPeriod}</div>
        </div>
      </div>
      <p id="earningsMessage" className="message">
        {vm.dashboardData.earnings.ok ? 'Earnings from metering data.' : `Unable to load earnings: ${vm.dashboardData.earnings.error ?? 'unknown error'}`}
      </p>
      <div className="stat-grid">
        <div className="stat-card"><p className="stat-label">Today</p><p id="earnToday" className="stat-value green">{vm.formatMoney(vm.earningsPayload.today)}</p></div>
        <div className="stat-card"><p className="stat-label">This Week</p><p id="earnWeek" className="stat-value">{vm.formatMoney(vm.earningsPayload.thisWeek)}</p></div>
        <div className="stat-card"><p className="stat-label">This Month</p><p id="earnMonth" className="stat-value">{vm.formatMoney(vm.earningsPayload.thisMonth)}</p></div>
      </div>
      <div className="panel-grid two-col">
        <article className="panel">
          <div className="panel-head"><h3>Earnings Over Time</h3></div>
          <canvas id="earningsLineChart" width={500} height={220} />
        </article>
        <article className="panel">
          <div className="panel-head"><h3>By Provider</h3></div>
          <canvas id="earningsPieChart" width={300} height={220} />
        </article>
      </div>
    </section>
  );
}
