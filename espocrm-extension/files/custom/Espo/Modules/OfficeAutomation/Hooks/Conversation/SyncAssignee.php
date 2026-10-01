<?php

namespace Espo\Modules\OfficeAutomation\Hooks\Conversation;

use Espo\ORM\Entity;
use Espo\ORM\EntityManager;
use Espo\ORM\Query\UpdateBuilder;
use Espo\ORM\Repository\Option\SaveOptions;

/** When a conversation is (re)assigned, its messages follow. */
class SyncAssignee
{
    public static int $order = 5;

    public function __construct(private EntityManager $entityManager) {}

    public function afterSave(Entity $entity, array $options): void
    {
        if ($entity->isNew() || !$entity->isAttributeChanged('assignedUserId')) {
            return;
        }

        $this->entityManager->getQueryExecutor()->execute(
            UpdateBuilder::create()
                ->in('SocialMessage')
                ->set(['assignedUserId' => $entity->get('assignedUserId')])
                ->where(['conversationId' => $entity->getId()])
                ->build()
        );
    }
}
