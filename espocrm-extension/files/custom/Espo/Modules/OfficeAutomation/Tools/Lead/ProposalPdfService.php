<?php

namespace Espo\Modules\OfficeAutomation\Tools\Lead;

use Espo\Core\Acl;
use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use Espo\Core\FileStorage\Manager as FileStorageManager;
use Espo\Entities\Attachment;
use Espo\ORM\EntityManager;
use Espo\Tools\Email\SendService;
use Espo\Tools\Pdf\Data;
use Espo\Tools\Pdf\Params;
use Espo\Tools\Pdf\Service as PdfService;

/**
 * Emails a lead the branded PDF version of their proposal (template "Lead proposal PDF"),
 * from the company mailbox, linked to the lead. A person presses the button; nothing is sent automatically.
 */
class ProposalPdfService
{
    public const TEMPLATE_NAME = 'Lead proposal PDF';

    public function __construct(
        private EntityManager $entityManager,
        private Acl $acl,
        private PdfService $pdfService,
        private FileStorageManager $fileStorage,
        private SendService $sendService
    ) {}

    /** @throws BadRequest @throws Forbidden @throws NotFound */
    public function send(string $leadId): void
    {
        $lead = $this->entityManager->getEntityById('Lead', $leadId) ?? throw new NotFound();

        if (!$this->acl->checkEntityEdit($lead) || !$this->acl->checkScope('Email', 'create')) {
            throw new Forbidden();
        }

        $to = $lead->get('emailAddress') ?: throw new BadRequest('The lead has no email address.');

        if (trim((string) $lead->get('aiProposalBody')) === '') {
            throw new BadRequest('The lead has no proposal yet.');
        }
        if ($lead->get('emailAddressIsOptedOut')) {
            throw new BadRequest('The lead opted out of emails.');
        }

        $template = $this->entityManager->getRDBRepository('Template')
            ->where(['name' => self::TEMPLATE_NAME, 'entityType' => 'Lead', 'status' => 'Active'])->findOne()
            ?? throw new BadRequest('PDF template "' . self::TEMPLATE_NAME . '" is missing or inactive.');

        $account = $this->entityManager->getRDBRepository('InboundEmail')
            ->where(['status' => 'Active', 'useSmtp' => true])->order('smtpIsForMassEmail', 'DESC')->findOne()
            ?? throw new BadRequest('No company mailbox with SMTP is configured.');

        // The proposal text is AI output and may contain text from a lead's notes: it must never reach the PDF as HTML.
        // The template therefore uses {{{proposalHtml}}} (escaped here), never the raw field in triple braces.
        if (preg_match('/\{\{\{\s*aiProposalBody\s*\}\}\}/', (string) $template->get('body'))) {
            throw new BadRequest('The PDF template prints the proposal unescaped. Re-run setup-m4 to restore the safe template.');
        }
        $data = Data::create()->withAdditionalTemplateData((object) [
            'proposalHtml' => nl2br(htmlspecialchars((string) $lead->get('aiProposalBody'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'), false),
        ]);

        // Access to the lead was checked above; the template is a company asset, so employees need no Template access.
        $pdf = $this->pdfService->generate('Lead', $leadId, $template->getId(), Params::create()->withAcl(false), $data);

        /** @var Attachment $attachment */
        $attachment = $this->entityManager->createEntity('Attachment', [
            'name' => $pdf->getFilename() ?? 'Proposal.pdf',
            'type' => 'application/pdf',
            'role' => 'Attachment',
            'size' => $pdf->getLength(),
            'relatedType' => 'Email',
            'field' => 'attachments',
        ]);
        $this->fileStorage->putContents($attachment, $pdf->getString());

        $first = trim((string) $lead->get('firstName'));
        $email = $this->entityManager->createEntity('Email', [
            'name' => 'Our proposal for ' . ($lead->get('accountName') ?: $lead->get('name')),
            'body' => 'Hi ' . ($first !== '' ? $first : 'there') . ",\n\nThank you for your interest. Please find our proposal attached as a PDF.\n\n" .
                'Reply to this email with any question, or suggest a time for a short call.' . "\n\nBest regards,\n" . $account->get('fromName'),
            'isHtml' => false,
            'status' => 'Sending',
            'from' => $account->get('emailAddress'),
            'to' => $to,
            'parentType' => 'Lead',
            'parentId' => $leadId,
            'attachmentsIds' => [$attachment->getId()],
        ]);

        $this->sendService->send($email, null);
    }
}
