<template>
  <div class="app-shell">
    <header class="glass-card topbar">直播弹幕助手</header>
    <aside class="glass-card sidebar">房间管理</aside>
    <main class="glass-card feed">弹幕流</main>
    <section class="glass-card reply">AI 回复面板</section>
    <footer class="glass-card statusbar">状态栏</footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  height: 100%;
  gap: 10px;
  padding: 10px;
  grid-template-columns: 220px 1fr 300px;
  grid-template-rows: 52px 1fr 32px;
  grid-template-areas: 'top top top' 'side feed reply' 'status status status';
}
.topbar { grid-area: top; display: flex; align-items: center; padding: 0 16px; font-weight: 700; }
.sidebar { grid-area: side; }
.feed { grid-area: feed; }
.reply { grid-area: reply; }
.statusbar { grid-area: status; display: flex; align-items: center; padding: 0 12px; font-size: 12px; }
</style>
