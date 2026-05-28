// ============================================
// TIPOS COMPLETOS - CobranzaPro ERP v2.0
// ============================================

export type UserRole = 'super' | 'admin' | 'cobrador';

export interface User {
  id: string;
  username: string;
  password: string;
  role: UserRole;
  name: string;
}

export interface Cliente {
  id: string;
  nombre: string;
  telefono: string;
  direccion: string;
  latitud?: number;
  longitud?: number;
  zona?: string;
  cobradorId?: string;
  fechaAlta: string;
  observaciones: string;
  ultimaVisita?: string;
  ultimaPromesa?: string;
}

export interface Producto {
  id: string;
  nombre: string;
  precioCosto: number;
  precioVenta: number;
  stock: number;
  stockMinimo: number;
  categoria: string;
}

export interface Cuota {
  numero: number;
  fechaVencimiento: string;
  monto: number;
  saldo: number;
  estado: 'pendiente' | 'pagado' | 'parcial' | 'vencido';
  fechaPago?: string;
  montoPagado?: number;
  interesesMora?: number;
  observaciones?: string;
  nuevaFechaVisita?: string;
}

export interface Ficha {
  id: string;
  clienteId: string;
  tipo: 'venta' | 'prestamo';
  // Venta
  productoId?: string;
  cantidad?: number;
  // Préstamo
  montoTotal?: number;
  // Común
  costoTotal: number;
  precioVentaTotal: number;
  gananciaNeta: number;
  cuotaInicial: number;
  cantidadCuotas: number;
  montoCuota: number;
  tasaInteres: number;
  fechaInicio: string;
  cuotas: Cuota[];
  estado: 'activa' | 'cancelada' | 'vencida';
  createdBy: string;
  fechaCreacion: string;
  historialPagos: HistorialPago[];
}

export interface HistorialPago {
  id: string;
  fichaId: string;
  clienteId: string;
  numeroCuota: number;
  montoPagado: number;
  fechaPago: string;
  horaPago: string;
  metodoPago: 'efectivo' | 'transferencia' | 'otro';
  observacion?: string;
  sincronizado: boolean;
}

export interface Gasto {
  id: string;
  fecha: string;
  categoria: 'combustible' | 'comida' | 'reparaciones' | 'otros';
  monto: number;
  nota: string;
  usuarioId: string;
  sincronizado: boolean;
}

export interface CierreLote {
  id: string;
  fecha: string;
  usuarioId: string;
  montoSistematico: number;
  montoFisico: number;
  diferencia: number;
  tipo: 'correcto' | 'faltante' | 'sobrante';
  observaciones: string;
  validadoPor?: string;
  fechaValidacion?: string;
}

export interface PromesaPago {
  id: string;
  clienteId: string;
  fichaId: string;
  numeroCuota: number;
  fechaPromesa: string;
  montoPrometido: number;
  observacion: string;
  cumplida: boolean;
  fechaRegistro: string;
  usuarioId: string;
}

export interface Alerta {
  id: string;
  tipo: 'pago' | 'cierre' | 'mora' | 'sync' | 'stock' | 'diferencia_caja';
  titulo: string;
  mensaje: string;
  prioridad: 'baja' | 'media' | 'alta' | 'critica';
  leida: boolean;
  usuarioId: string;
  fecha: string;
  datos: Record<string, unknown>;
}

export interface LogAuditoria {
  id: string;
  fecha: string;
  hora: string;
  usuarioId: string;
  usuarioNombre: string;
  usuarioRol: UserRole;
  accion: string;
  modulo: string;
  detalle: string;
  ip?: string;
}

export interface SincronizacionOffline {
  id: string;
  tipo: 'pago' | 'gasto' | 'cierre' | 'promesa';
  datos: unknown;
  timestamp: string;
  sincronizado: boolean;
  reintentos: number;
}

export interface Configuracion {
  empresaNombre: string;
  empresaRuc: string;
  empresaTelefono: string;
  empresaDireccion: string;
  margenPredeterminado: number;
  tasaInteresMoraDiaria: number;
  diasGracia: number;
  formatoComprobante: 'estandar' | 'moderno' | 'minimalista';
  colorPrimario: string;
  moneda: string;
  simboloMoneda: string;
}

export type EstadoMorosidad = 'verde' | 'amarillo' | 'rojo';

export interface ResumenDashboard {
  totalClientes: number;
  clientesActivos: number;
  clientesEnMora: number;
  fichesActivas: number;
  montoTotalCobrar: number;
  montoTotalCobradoMes: number;
  montoEsperadoHoy: number;
  montoRecaudadoHoy: number;
  diferenciaCaja: number;
  totalGastosDia: number;
  gananciaNetaDia: number;
  alertasPendientes: number;
  promesasPendientes: number;
}
