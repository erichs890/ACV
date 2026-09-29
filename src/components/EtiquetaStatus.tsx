import { CheckCircle2 } from 'lucide-react';
import type { StatusVaga } from '../types';
import { STATUS_VAGA } from '../dados';
import Orbe, { type EstadoOrbe } from './Orbe';

/**
 * O selo de status de uma vaga. Nos status que são espera de verdade ele ganha um orbe animado, para separar
 * o que está ACONTECENDO agora do que só está parado num estado.
 *
 * Existe como componente porque o selo aparecia em três telas com o mesmo markup copiado: a primeira que
 * ganhasse o orbe deixaria as outras duas para trás, e a fila do Painel ia continuar parecendo congelada
 * enquanto a mesma vaga se movia na Automação.
 */
const COM_ORBE: Partial<Record<StatusVaga, EstadoOrbe>> = {
  em_andamento: 'enviando', // o robô está preenchendo e enviando esta agora
  aguardando_pergunta: 'esperando', // parada à sua espera
  aguardando_aprovacao: 'esperando',
};

export default function EtiquetaStatus({ status }: { status: StatusVaga }) {
  const st = STATUS_VAGA[status];
  const orbe = COM_ORBE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-[9px] px-2 py-0.5 text-[10px] font-bold ${st.classe}`}>
      {orbe && <Orbe estado={orbe} />}
      {status === 'enviada' && <CheckCircle2 size={12} aria-hidden />}
      {st.rotulo}
    </span>
  );
}
