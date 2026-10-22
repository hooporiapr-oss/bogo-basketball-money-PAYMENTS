/* ══════════════════════════════════════════════════════════════════
   LA AYUDA NO NOMBRA NINGÚN PRODUCTO

   /coach/chat lo comparten los dos: el entrenador de baloncesto entra
   por Hooporia y el programa de escuela por Cada Punto, con el mismo
   código, la misma base y este mismo endpoint.

   Durante un tiempo el texto del modelo decía "Cada Punto" seis
   veces. Un entrenador de Hooporia preguntaba algo y la ayuda le
   contestaba con el nombre del OTRO producto — en la única página a
   la que se va cuando uno ya está perdido. No daba error, no salía en
   rojo y ninguna prueba lo miraba.

   No se arregla preguntándole a la base de qué producto es cada
   código: eso son dos textos que mantener y uno de los dos se queda
   viejo. Se arregla no nombrando ninguno. El que escribe está DENTRO
   de su propia página y ya sabe dónde está.

   Esto comprueba las dos mitades de eso:
     · que no se le haya vuelto a colar una marca, y
     · que al quitarla no haya empezado a sonar a tercero. Decir
       "ellos" o "la empresa" desde la propia página del entrenador es
       el otro fallo, y es el que se cuela al limpiar nombres.

   No levanta el servidor ni pide llaves: lee server.js.

       node prueba-ayuda-marca.js
   ══════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

let fallos = 0;
const ok  = (m) => console.log('  ok   ' + m);
const mal = (m) => { fallos++; console.log('  MAL  ' + m); };
const si  = (v, m) => (v ? ok(m) : mal(m));

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

/* Las marcas. La de Hooporia también: la trampa es simétrica, y el día
   que alguien "arregle" esto poniendo Hooporia, el de la escuela leerá
   el nombre equivocado.

   CON MAYÚSCULAS Y SIN /i, a propósito, y no es puntillismo. Este
   texto está lleno de "cada punto que anote ese nene" —es de lo que
   va el producto entero— y buscar la marca sin distinguir mayúsculas
   daba por marca la frase corriente. Igual con "anotado", que aquí
   quiere decir apuntado, no el nombre viejo de la plataforma.

   Una marca es un nombre propio y se escribe como tal; lo que va en
   minúscula es el idioma. Pasó: la primera versión de esta prueba
   fallaba señalando la línea que explica de qué va todo. */
const MARCAS = [/Cada Punto/, /Hooporia/, /Anotado\b/, /Apoyazo/];

/* Un trozo de server.js por su nombre, cortado en el cierre que le
   toca: `; para un texto, ]; o }; para una lista o un objeto.

   Los dos no se buscan igual. Una lista y un objeto cierran en
   columna cero, así que se busca el salto de línea delante —si no,
   un "};" de cualquier función de dentro corta el trozo antes de
   tiempo. Un texto cierra donde acabe la última frase, con sangría
   y todo, así que ése se busca tal cual. Buscar los dos con el salto
   delante devolvía null para COACH_KB, y las comprobaciones salían
   como "no encuentro" en vez de como lo que son. */
function trozo(nombre, cierre) {
  const i = src.indexOf('const ' + nombre);
  if (i < 0) return null;
  const desde = i + nombre.length;
  const j = cierre === '`;'
    ? src.indexOf('`;', src.indexOf('`', desde) + 1)
    : src.indexOf('\n' + cierre, desde);
  return j < 0 ? null : src.slice(i, j + cierre.length + 1);
}

/* Todo lo que puede acabar DELANTE de un entrenador por esta ruta:
   lo que lee el modelo, y las respuestas fijas que ni pasan por él.
   Las de dinero y las de tope son las que más se leen, porque son las
   que salen cuando algo va mal. */
const PIEZAS = [
  ['COACH_KB',    '`;',  'el texto que lee el modelo'],
  ['DINERO',      '];',  'las respuestas de dinero, palabra por palabra'],
  ['SIN_CIFRAS',  '};',  'la respuesta de cuando huele a dinero'],
  ['TOPE_DICHO',  '};',  'lo que se dice al llegar al tope'],
];

console.log('\n1 · Nada de lo que le llega al entrenador nombra un producto\n');
const kb = trozo('COACH_KB', '`;');
for (const [nombre, cierre, dicho] of PIEZAS) {
  const t = trozo(nombre, cierre);
  if (!t) { mal('no encuentro ' + nombre + ' en server.js'); continue; }
  const encontradas = MARCAS.filter((m) => m.test(t)).map((m) => String(m));
  si(encontradas.length === 0,
     nombre + ' — ' + dicho +
     (encontradas.length ? ' — nombra: ' + encontradas.join(', ') : ''));
}

console.log('\n2 · Y se lo dice al modelo, no sólo lo evita\n');
{
  /* Quitar los nombres del texto no basta: el modelo sabe cómo se
     llaman los productos y, si le preguntan, suelta uno. La orden
     tiene que estar escrita. */
  if (!kb) mal('sin COACH_KB no hay nada que comprobar');
  else {
    si(/NO NOMBRAS EL PRODUCTO/.test(kb),
       'le dice en mayúsculas que no nombre el producto');
    si(/su propia página/.test(kb),
       'y le explica por qué: el que escribe ya sabe dónde está');
    si(/preguntan cómo se llama/.test(kb),
       'y qué hacer si se lo preguntan de frente');
  }
}

console.log('\n3 · Pero sigue hablando desde dentro\n');
{
  /* El fallo gemelo del anterior. Al quitar la marca es facilísimo
     dejar al modelo hablando de la plataforma en tercera persona, y
     "ellos arman la campaña" leído en tu propia página suena a que
     la página es de otra gente. */
  if (!kb) mal('sin COACH_KB no hay nada que comprobar');
  else {
    si(/di "nosotros"/.test(kb), 'le manda decir "nosotros"');
    si(/Nunca "ellos"/.test(kb), 'y le prohíbe el "ellos"');
    si(/DE PARTE de la plataforma/.test(kb),
       'y deja dicho de parte de quién habla');
  }
}

console.log('\n4 · Y sirve a los dos, no sólo al de baloncesto\n');
{
  if (!kb) mal('sin COACH_KB no hay nada que comprobar');
  else {
    /* El baloncesto no se borra —la mitad de los que escriben son
       entrenadores y hablar de tiros libres es parte del trabajo—,
       pero deja de ser la suposición por defecto. */
    si(/programa de escuela/.test(kb) || /salón/.test(kb),
       'cuenta con el que lleva un programa de escuela');
    si(/tiros libres/.test(kb),
       'y sigue contestando de baloncesto al que viene a eso');
    si(!/Hablas con gente de baloncesto, así que/.test(kb),
       'y ya no da por hecho que todo el que escribe es de baloncesto');
  }
}

console.log('\n' + (fallos === 0
  ? '✓ la ayuda vale para los dos productos y no nombra ninguno'
  : '✗ ' + fallos + ' fallo(s)'));
process.exit(fallos === 0 ? 0 : 1);
