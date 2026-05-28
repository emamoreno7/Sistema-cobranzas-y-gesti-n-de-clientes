# SPEC.md — CobranzaPro ERP v3.0

## 1. Concepto & Visión

**CobranzaPro ERP** es un sistema de gestión comercial diseñado para cobradores de campo y administradores. La experiencia prioriza la eficiencia en calle: interfaz oscura de alto contraste legible a la luz del sol, interacciones táctiles grandes, y resiliencia offline. El rediseño v3.0 sigue los lineamientos estéticos de Apple iOS — tarjetas con border-radius generoso, sombras sutiles, tipografía SF Pro, y glassmorphism en la navegación.

## 2. Design Language

### Aesthetic Direction
Apple iOS 17 Dark Mode: superficies slate muy oscuras, acentos vibrantes sobre fondos neutros, bordes redondeados pronunciados, jerarquía tipográfica clara.

### Color Palette
- **Background**: `#000000` (fondo puro), `#1c1c1e` (tarjetas), `#2c2c2e` (elementos)
- **Surface**: `#3a3a3c` (inputs, hover)
- **Primary**: `#6366f1` (Indigo — acciones principales)
- **Success**: `#34C759` (Verde — Cobra, Pagado)
- **Warning**: `#FF9500` (Naranja — Gastos, Parcial)
- **Danger**: `#FF3B30` (Rojo — Mora, Alertas)
- **Info**: `#007AFF` (Azul — Ruta, Maps)
- **Text Primary**: `#ffffff`
- **Text Secondary**: `#8e8e93`
- **Semáforo**: Verde `#34C759` | Amarillo `#FFD60A` | Rojo `#FF453A`

### Typography
- Font: `system-ui, -apple-system, 'SF Pro Display', 'Inter', sans-serif`
- Headings: 700 weight, 22-28px
- Body: 400/500 weight, 15-17px
- Labels: 600 weight, 13px
- Mono: `'SF Mono', 'JetBrains Mono', monospace` para montos

### Spatial System
- Border radius: `border-radius: 28px` (tarjetas grandes), `16px` (botones), `12px` (inputs)
- Shadows: `0 4px 12px rgba(0,0,0,0.05)` (iOS style), `0 8px 32px rgba(0,0,0,0.3)` (modales)
- Spacing: 4px base, múltiplos de 4 (8, 12, 16, 24, 32)

### Motion Philosophy
- Transiciones: 200ms ease-out por defecto
- Botones presión: `scale(0.95)` al tocar, `scale(1.02)` al soltar
- Modales: fade-in 200ms + slide-up 300ms cubic-bezier
- Skeleton loading para estados de carga
- Pull-to-refresh en listas móviles

### Visual Assets
- Iconos: Lucide React (outline, 1.5px stroke)
- Ilustraciones: SVG inline mínimos
- Sin imágenes externas — todo CSS/SVG

## 3. Layout & Structure

### Desktop (>1024px)
```
┌──────────┬────────────────────────────────────────┐
│ Sidebar  │  Top Bar (Search + Alerts + User)       │
│  280px   ├────────────────────────────────────────┤
│          │                                         │
│ Nav      │  Page Content (scrollable)             │
│ Items    │                                         │
│          │                                         │
├──────────┴────────────────────────────────────────┤
│            Bottom Tab Bar (mobile only)             │
└────────────────────────────────────────────────────┘
```

### Mobile (<768px)
- Sin sidebar — Bottom Tab Bar con 5 items
- Top bar colapsa a solo logo + notificaciones
- Cards full-width con gap-3
- Swipe gestures en filas de tablas

## 4. Features & Interactions

### 4.1 Sistema de Login
- Accesos rápidos demo (super/admin/cobrador)
- Animación de carga 600ms
- Token de sesión en localStorage

### 4.2 Dashboard (Rediseño iOS Grid)
- **Grid de 4 App Icons** (iOS style):
  - 🟢 Registrar Cobro — Verde #34C759 — Billetera
  - 🔵 Ruta del Día — Azul #007AFF — Mapa
  - 🔴 Lista Morosos — Rojo #FF3B30 — Alerta
  - 🟠 Gastos y Caja — Naranja #FF9500 — Gráfico
- **Tarjetas de Métricas** (clickeables para filtrar):
  - Efectividad de Cobro %
  - Total Recaudado
  - Clientes en Mora (filtra tabla a rojo)
  - Proyección semanal (mini SVG bars)
- Efecto presión en todos los botones (scale 0.95)
- border-radius: 28px en todas las tarjetas
- Box-shadow: `0 4px 12px rgba(0,0,0,0.05)`

### 4.3 Módulo de Clientes
- Buscador inteligente global (autocompletado)
- Botón geolocalización con Haversine
- Semáforo de morosidad (verde/amarillo/rojo)
- Lista swipeable con acciones rápidas
- Integración WhatsApp (`wa.me`) y Google Maps

### 4.4 Fichas de Operación (Sistema Dual)
- **Cara A (Anverso)**: detalle, costo, precio, ganancia, saldo
- **Cara B (Grilla de Pagos)**: tabla con cuotas
- **Lógica de Pago Parcial**:
  - Input numérico en cada celda de cuota
  - Si monto < cuota: estado='parcial' (naranja)
  - Saldo pendiente arrastrado a siguiente cuota
  - Recálculo automático del saldo total en tiempo real
- Exportación PDF con jsPDF
- Envío por WhatsApp

### 4.5 Ruta Inteligente (GPS)
- Botón "Optimizar Ruta" en dashboard cobrador
- `navigator.geolocation.getCurrentPosition()`
- Fórmula Haversine para distancia en km
- Reordena lista por cercanía ascendente
- Muestra distancia en km junto a cada cliente

### 4.6 Cierre de Lote (Arqueo)
- El cobrador registra monto físico al final del día
- Comparación con monto sistémico
- Genera alerta al admin si hay diferencia
- Validación admin para congelar datos

### 4.7 Módulo de Gastos
- Categorías: Combustible, Comida, Reparaciones, Otros
- Monto + Nota por registro
- Resta de ganancia neta en dashboard admin

### 4.8 Promesas de Pago
- Campo observaciones + nueva fecha
- Recordatorios en dashboard para el día correspondiente
- Indicador visual en hoja de ruta

### 4.9 KPIs y Analítica (Admin/Super)
- Efectividad: (Recaudado / Esperado) × 100
- Ranking de cobradores
- Proyección 7 días (SVG bar chart)
- Morosidad por zona

### 4.10 PWA + Offline
- `manifest.json` con icons y theme
- `Service Worker` con cache strategy
- IndexedDB para cola offline
- Sync automática al reconectar
- Timestamp inviolable en cada operación

### 4.11 Filtros en Dashboard
- Tarjeta "Clientes en Mora" → click → filtra tabla a rojo
- Tarjeta "Efectividad" → click → filtra a >50% / <50%
- Indicador visual de filtro activo

## 5. Component Inventory

### AppIconButton
- States: default, hover (scale 1.02), active (scale 0.95), disabled (opacity 0.4)
- Size: 80x80px en móvil, 100x100px en desktop
- Border-radius: 24px
- Shadow: `0 4px 12px rgba(color, 0.3)`

### MetricCard
- States: default, active (con filtro), loading
- Click → activa filtro en tabla inferior
- Indicador de filtro activo (borde accent + badge)

### ClienteRow
- Swipe left → acciones (WhatsApp, Maps, Editar)
- Swipe right → detalle rápido
- Semáforo dot a la izquierda
- Distance badge si GPS activo

### CuotaCell
- Estados: pendiente (gray), parcial (orange), pagado (green), vencido (red pulse)
- Click → modal de pago con input de monto
- Si monto < saldo → arrastra diferencia

### BottomTabBar (mobile)
- Glassmorphism: `backdrop-blur-xl bg-black/80`
- 5 tabs: Inicio, Clientes, +Cobro (FAB), Ruta, Más
- Active state: ícono filled + label visible
- Safe area padding bottom

## 6. Technical Approach

### Frontend
- React 19 + TypeScript
- Vite + Tailwind CSS
- jsPDF (PDF)

### Data Layer
- localStorage como store primario (preparado para API)
- IndexedDB para cola offline
- Patrón Context + Reducer para estado global

### PWA
- manifest.json con display: standalone
- Service Worker: cache-first para assets, network-first para API
- Install prompt detection

### API Design (preparado)
```
POST /api/sync          — recibe timestamp + datos offline
GET  /api/data          — obtiene estado completo
POST /api/pago          — registra pago con token auth
GET  /api/kpis          — métricas agregadas
```

### Security
- Token de sesión en cada operación de escritura
- Roles validados en frontend y (futuro) backend
- Timestamps ISO 8601 en todos los registros
- Logs de auditoría inmutables en localStorage
