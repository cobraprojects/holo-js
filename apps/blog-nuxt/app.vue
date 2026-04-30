<template>
  <div class="shell">
    <header class="header">
      <nav class="nav">
        <NuxtLink to="/" class="brand">blog-nuxt</NuxtLink>
        <NuxtLink to="/posts">Posts</NuxtLink>
        <NuxtLink to="/admin">Admin</NuxtLink>
      </nav>
    </header>
    <main class="content">
      <NuxtPage />
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  background: #0b1020;
  color: #e5eef8;
  font-family: Inter, Arial, sans-serif;
}
.header {
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
}
.nav,
.content {
  max-width: 72rem;
  margin: 0 auto;
  padding: 1rem 1.5rem;
}
.nav {
  display: flex;
  gap: 1rem;
}
.brand {
  font-weight: 700;
}
a {
  color: #cbd5e1;
  text-decoration: none;
}
</style>
