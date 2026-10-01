// Handles "ProposalBrief status -> generating": writes a unique proposal into every lead of the brief's target list.
import type { Espo } from './espo.ts';
import type { KbArticle } from './ai.ts';
import { generateProposal, type Lead } from './lead-ai.ts';

const BATCH = 20;
const FIELDS = 'id,firstName,lastName,name,accountName,industryText,addressCity,interestTopic,description,aiProposalBody,emailAddressIsOptedOut,emailAddressIsInvalid,targetListIsOptedOut';

export class ProposalProcessor {
  private espo: Espo;
  private log: (o: object) => void;
  private running = new Set<string>();

  constructor(espo: Espo, log: (o: object) => void = o => console.log(JSON.stringify(o))) {
    this.espo = espo;
    this.log = log;
  }

  private async leads(targetListId: string): Promise<(Lead & { aiProposalBody?: string })[]> {
    const out: any[] = [];
    for (let offset = 0; ; offset += 200) {
      const q = new URLSearchParams({ select: FIELDS, maxSize: '200', offset: String(offset), orderBy: 'createdAt' });
      const page = await this.espo.get<{ list: any[] }>(`TargetList/${targetListId}/leads?${q}`);
      out.push(...page.list);
      if (page.list.length < 200) break;
    }
    // Opted-out or invalid addresses will never be mailed, so they get no proposal.
    return out.filter(l => !l.emailAddressIsOptedOut && !l.targetListIsOptedOut && !l.emailAddressIsInvalid);
  }

  async handle(briefId: string): Promise<void> {
    if (this.running.has(briefId)) return;
    this.running.add(briefId);
    try {
      await this.run(briefId);
    } catch (e) {
      this.log({ event: 'brief_error', briefId, error: String(e) });
      await this.espo.put(`ProposalBrief/${briefId}`, { status: 'draft', regenerate: false }).catch(() => {});
    } finally {
      this.running.delete(briefId);
    }
  }

  private async run(id: string): Promise<void> {
    const brief = await this.espo.get(`ProposalBrief/${id}`);
    if (brief.status !== 'generating') return this.log({ event: 'brief_skip', id, status: brief.status });
    if (!brief.targetListId) return void (await this.espo.put(`ProposalBrief/${id}`, { status: 'draft' }));

    const leads = await this.leads(brief.targetListId);
    const todo = brief.regenerate ? leads : leads.filter(l => !l.aiProposalBody);
    let generated = leads.length - todo.length;
    let failed = 0;
    await this.espo.put(`ProposalBrief/${id}`, { totalCount: leads.length, generatedCount: generated, failedCount: 0 });

    const articles = await this.espo.list('KnowledgeBaseArticle', { 'where[0][type]': 'equals', 'where[0][attribute]': 'status', 'where[0][value]': 'Published', select: 'name,bodyPlain,body' });
    const kb: KbArticle[] = articles.map((a: any) => ({ name: a.name, text: a.bodyPlain || String(a.body ?? '').replace(/<[^>]+>/g, ' ') }));
    const b = { instructions: brief.instructions, wordLimit: brief.wordLimit };

    for (let i = 0; i < todo.length; i += BATCH) {
      const results = await Promise.all(todo.slice(i, i + BATCH).map(async lead => {
        try {
          const p = await generateProposal(lead, b, kb);
          await this.espo.put(`Lead/${lead.id}`, { aiProposalSubject: p.subject, aiProposalBody: p.body, proposalBriefId: id });
          return true;
        } catch (e) {
          this.log({ event: 'proposal_failed', briefId: id, leadId: lead.id, error: String(e) });
          return false;
        }
      }));
      generated += results.filter(Boolean).length;
      failed += results.filter(r => !r).length;
      await this.espo.put(`ProposalBrief/${id}`, { generatedCount: generated, failedCount: failed });
    }

    await this.espo.put(`ProposalBrief/${id}`, { status: 'review', regenerate: false, generatedCount: generated, failedCount: failed });
    this.log({ event: 'brief_done', id, total: leads.length, generated, failed });
  }
}
