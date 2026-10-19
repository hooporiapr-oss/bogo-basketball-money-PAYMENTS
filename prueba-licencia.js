/* ══════════════════════════════════════════════════════════════════
   LA LICENCIA DE UN EVENTO — /licencia

   El único cobro que Hooporia hace. No lo paga un padrino: lo paga
   el programa, una vez por evento, y la llave de Stripe del servidor
   es de PRODUCCIÓN. O sea que un fallo aquí no es una pantalla fea:
   es una factura de verdad a un cliente de verdad, o una que sale
   dos veces, o una que se cobra cuando se había prometido no
   cobrarla.

   Por eso lo que se comprueba no es el importe —ése sale de
   licencia_calculo() en la base, y ahí se mira con un SELECT— sino
   el ORDEN y las NEGATIVAS, que es lo que vive en el servidor:

   1 · que sin confirmar NO toque Stripe. Un endpoint de un paso con
       una llave live es una factura real a un clic mientras se
       prueba.
   2 · que un evento sin una sola promesa no se pueda facturar. Eso
       está publicado en cinco páginas y firmado en la casilla de
       equipo.html; si vive sólo en la prosa, un día se cobra igual.
   3 · que la fila se escriba ANTES de llamar a Stripe. Lo que impide
       la factura doble es el índice único de la tabla, y el índice
       no protege nada si se factura primero y se apunta después.
   4 · que si Stripe falla, la fila se retire. Si se queda, el evento
       figura cobrado sin estarlo y el índice único impide volver a
       intentarlo — un evento que no se puede facturar nunca más.
   5 · que la factura se cree antes que su línea y la línea vaya
       atada a su id. Al revés, Stripe barre todas las líneas
       pendientes de ese cliente y una línea huérfana de un intento
       fallido acabaría cobrada dentro de la factura siguiente.

   Se corre el código DE VERDAD, sacado de server.js.

       node prueba-licencia.js
   ══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const vm = require('vm');

let fallos = 0;
const ok  = (m) => console.log('  ok   ' + m);
const mal = (m) => { fallos++; console.log('  MAL  ' + m); };
const eq  = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b)
  ? ok(m + ' → ' + JSON.stringify(a))
  : mal(m + '\n         esperaba: ' + JSON.stringify(b) +
            '\n         vino:     ' + JSON.stringify(a)));

/* ── El código de verdad ────────────────────────────────────────── */
const s = fs.readFileSync(__dirname + '/server.js', 'utf8');
const i = s.indexOf('const LICENCIA_DIAS');
const marca = s.indexOf("console.error('/licencia:'", i);
if (i < 0 || marca < 0) { console.error('no encuentro el bloque de la licencia'); process.exit(1) }
const fin = s.indexOf('\n});\n', marca);
const codigo = s.slice(i, fin + 5);

/* ── Las piezas de fuera ────────────────────────────────────────── */
let manejador = null;
let calculo = null;          // lo que contesta licencia_calculo
let insertFalla = null;      // {code:'23505'} para simular llave duplicada
let stripeFalla = false;
let pasos = [];              // el orden de todo lo que se hace
let filas = [];              // lo que quedó escrito en licencias
let admin = 'john@gostardigital.com';

const supabaseFalso = {
  async rpc(nombre, args) {
    pasos.push('rpc:' + nombre);
    if (nombre !== 'licencia_calculo') throw new Error('rpc inesperada: ' + nombre);
    return { data: calculo, error: null };
  },
  from(tabla) {
    return {
      insert(fila) {
        pasos.push('insert:' + tabla);
        if (insertFalla) return { select(){ return { async single(){ return { data:null, error: insertFalla } } } } };
        const puesta = Object.assign({ id: 'LIC1' }, fila);
        filas.push(puesta);
        return { select(){ return { async single(){ return { data: puesta, error: null } } } } };
      },
      update(patch) {
        return { eq(_c, id) {
          pasos.push('update:' + tabla);
          const f = filas.find(x => x.id === id);
          if (f) Object.assign(f, patch);
          return { select(){ return { async single(){ return { data: f, error: null } } } } };
        } };
      },
      delete() {
        return { async eq(_c, id) {
          pasos.push('delete:' + tabla);
          filas = filas.filter(x => x.id !== id);
          return { error: null };
        } };
      }
    };
  }
};

const llamadasStripe = [];
const stripeFalso = {
  customers: {
    async list(a){ pasos.push('stripe:customers.list'); llamadasStripe.push(['customers.list',a]); return { data: [] } },
    async create(a){ pasos.push('stripe:customers.create'); llamadasStripe.push(['customers.create',a]); return { id:'cus_1' } }
  },
  invoices: {
    async create(a){
      pasos.push('stripe:invoices.create'); llamadasStripe.push(['invoices.create',a]);
      if (stripeFalla) throw new Error('tarjeta de prueba: Stripe dijo que no');
      return { id:'in_1' };
    },
    async finalizeInvoice(id){ pasos.push('stripe:finalize'); llamadasStripe.push(['finalize',id]); return { id } },
    async sendInvoice(id){
      pasos.push('stripe:send'); llamadasStripe.push(['send',id]);
      return { id, hosted_invoice_url:'https://invoice.stripe.com/x', due_date: 1800000000 };
    }
  },
  invoiceItems: {
    async create(a){ pasos.push('stripe:invoiceItems.create'); llamadasStripe.push(['invoiceItems.create',a]); return { id:'ii_1' } }
  }
};

const contexto = {
  console: { log(){}, error(){} },
  process: { env: { STRIPE_SECRET_KEY: 'sk_live_NOESUNALLAVE' } },
  supabase: supabaseFalso,
  stripe: stripeFalso,
  requireAdmin: async () => admin,
  app: { post(ruta, fn){ if (ruta === '/licencia') manejador = fn } },
  Date
};
vm.createContext(contexto);
vm.runInContext(codigo, contexto, { filename: 'server.js (licencia)' });
if (!manejador) { console.error('no se registró /licencia'); process.exit(1) }

/* Un res de mentira que apunta lo que habría contestado. */
function llamar(body) {
  pasos = []; llamadasStripe.length = 0;
  let salida = null;
  const res = {
    status(c){ this._c = c; return this },
    json(o){ salida = { code: this._c || 200, body: o }; return this }
  };
  return manejador({ body, headers: {} }, res).then(() => salida);
}

const CALC_BUENO = {
  ok: true, challenge_id: 'RETO1', challenge: 'Demo Hooporia', campaign_id: 'CAMP1',
  programa: 'Diamantes', roster: 12, promesas: 3, cobrable: true, amount_cents: 4900,
  program_name: 'John', program_email: 'coach@programa.com', ya_facturada: false, licencia: null
};
const reset = () => { calculo = JSON.parse(JSON.stringify(CALC_BUENO));
                      insertFalla = null; stripeFalla = false; filas = []; admin = 'john@x.com' };

(async () => {

console.log('\n1 · Quién puede, y con qué\n');
reset(); admin = null;
eq((await llamar({ challenge_id:'RETO1' })).code, 403, 'sin ser admin, 403');
reset();
eq((await llamar({})).code, 400, 'sin reto, 400');

console.log('\n2 · La vista previa no toca Stripe\n');
reset();
let r = await llamar({ challenge_id:'RETO1' });
eq(r.code, 200, 'contesta');
eq(r.body.vista_previa, true, 'y se presenta como vista previa');
eq(r.body.amount_cents, 4900, 'con el importe que saldría');
eq(r.body.modo, 'live', 'y diciendo en qué modo está la llave');
eq(r.body.dias, 7, 'con los siete días de la página');
eq(pasos.filter(p => p.startsWith('stripe:')).length, 0,
   'y sin una sola llamada a Stripe');
eq(filas.length, 0, 'ni una fila escrita');
// La llave no se devuelve, sólo su modo.
eq(/sk_live_NOESUNALLAVE/.test(JSON.stringify(r.body)), false,
   'y la llave no sale en la respuesta');

console.log('\n3 · Sin promesas, sin cargo — en el código, no sólo en la página\n');
reset(); calculo.promesas = 0; calculo.cobrable = false; calculo.amount_cents = 0;
r = await llamar({ challenge_id:'RETO1', confirmar: true });
eq(r.code, 422, 'se niega');
eq(r.body.error, 'sin_promesas', 'y dice por qué');
eq(pasos.filter(p => p.startsWith('stripe:')).length, 0, 'sin tocar Stripe');
eq(filas.length, 0, 'y sin escribir nada');

console.log('\n4 · Las otras dos negativas\n');
reset(); calculo.ya_facturada = true; calculo.licencia = { id:'L0', estado:'enviada' };
r = await llamar({ challenge_id:'RETO1', confirmar: true });
eq(r.code, 409, 'un evento ya facturado se niega');
eq(pasos.filter(p => p.startsWith('stripe:')).length, 0, 'sin tocar Stripe');

reset(); calculo.program_email = null;
r = await llamar({ challenge_id:'RETO1', confirmar: true });
eq(r.code, 422, 'sin correo del programa, no se factura a nadie');
eq(r.body.error, 'sin_correo', 'y se dice');

console.log('\n5 · Facturar de verdad, y en qué orden\n');
reset();
r = await llamar({ challenge_id:'RETO1', confirmar: true });
eq(r.code, 200, 'contesta bien');
eq(r.body.ok, true, 'y dice que sí');
eq(r.body.stripe_invoice_id, 'in_1', 'con la factura de Stripe');
eq(r.body.url, 'https://invoice.stripe.com/x', 'y su enlace');

// El orden es la prueba. Primero la fila: lo que impide la factura
// doble es el índice único, y no protege nada si se factura antes.
const iFila   = pasos.indexOf('insert:licencias');
const iStripe = pasos.findIndex(p => p.startsWith('stripe:'));
eq(iFila >= 0 && iStripe > iFila, true,
   'la fila se escribe antes de la primera llamada a Stripe');

const iFact = pasos.indexOf('stripe:invoices.create');
const iLinea = pasos.indexOf('stripe:invoiceItems.create');
eq(iFact >= 0 && iLinea > iFact, true,
   'la factura se crea antes que su línea');
eq(pasos.indexOf('stripe:finalize') > iLinea, true, 'se firma después de tener la línea');
eq(pasos.indexOf('stripe:send') > pasos.indexOf('stripe:finalize'), true,
   'y se manda después de firmarla');

const factura = llamadasStripe.find(c => c[0] === 'invoices.create')[1];
eq(factura.collection_method, 'send_invoice', 'es una factura que se manda, no un cobro directo');
eq(factura.days_until_due, 7, 'con siete días, como dice la página');
eq(factura.auto_advance, false, 'y sin que Stripe la mueva sola antes de tener su línea');
eq(factura.metadata.challenge_id, 'RETO1', 'atada a su reto');

const linea = llamadasStripe.find(c => c[0] === 'invoiceItems.create')[1];
eq(linea.invoice, 'in_1', 'la línea va atada a ESA factura, no suelta');
eq(linea.amount, 4900, 'por el importe que dijo la base');
eq(linea.currency, 'usd', 'en dólares');

eq(filas[0].estado, 'enviada', 'la fila queda como enviada');
eq(filas[0].stripe_invoice_id, 'in_1', 'con su número de factura');
eq(filas[0].amount_cents, 4900, 'y con lo que se cobró, congelado');
eq(filas[0].roster, 12, 'y con la plantilla del día');

console.log('\n6 · Si Stripe falla\n');
reset(); stripeFalla = true;
r = await llamar({ challenge_id:'RETO1', confirmar: true });
eq(r.code, 502, 'se dice que falló');
eq(filas.length, 0, 'y la fila se retira — si no, el evento quedaría cobrado sin estarlo');
eq(pasos.indexOf('delete:licencias') > -1, true, 'se borra, no se deja a medias');

console.log('\n7 · Dos clics seguidos\n');
reset(); insertFalla = { code: '23505' };
r = await llamar({ challenge_id:'RETO1', confirmar: true });
eq(r.code, 409, 'el segundo se niega');
eq(r.body.error, 'ya_facturada', 'por llave duplicada, que es el índice haciendo su trabajo');
eq(pasos.filter(p => p.startsWith('stripe:')).length, 0,
   'y Stripe no llega a enterarse');

console.log('\n8 · El modo de la llave\n');
eq(contexto.modoDeStripe(), 'live', 'una llave sk_live se dice live');
contexto.process.env.STRIPE_SECRET_KEY = 'sk_test_x';
eq(contexto.modoDeStripe(), 'test', 'una sk_test, test');
contexto.process.env.STRIPE_SECRET_KEY = '';
eq(contexto.modoDeStripe(), 'sin llave', 'y sin llave se dice, no se adivina');

console.log('\n' + (fallos === 0
  ? '✓ la licencia sólo se factura cuando debe, y una sola vez'
  : '✗ ' + fallos + ' fallo(s)'));
process.exit(fallos === 0 ? 0 : 1);
})();
